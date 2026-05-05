import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import type {
	Ack,
	BusEvent,
	Error as ServerErrorFrame,
	Frame,
	HistoryResponse,
	Peer,
	PeersResponse,
	Presence,
	Welcome,
} from "./gen/pi_bus/v1/pi_bus_pb.ts";
import {
	DEFAULT_HOST,
	DEFAULT_PORT,
	PROTOCOL_VERSION,
	type AgentInput,
	type CommandOptions,
	type HistoryFilter,
	type PublishEventInput,
	type PublishOptions,
	type StringListInput,
	type SubscribeOptions,
	finiteNumber,
	makeId,
	normalizeBusEvent,
	normalizeRooms,
	normalizeTopics,
	nowIso,
	portNumber,
	positiveInteger,
	sanitizeAgent,
} from "./protocol.ts";
import { decodeFrames, encodeFrame, type FrameCase, type FrameValue } from "./wire.ts";

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_RECONNECT_MIN_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 10_000;
const DEFAULT_RECONNECT_JITTER = 0.2;

export type PiBusLogger = (...args: unknown[]) => void;

export interface PiBusClientOptions {
	host?: string;
	port?: number | string;
	socketPath?: string;
	token?: string;
	agent?: AgentInput;
	rooms?: StringListInput;
	topics?: StringListInput;
	reconnect?: boolean;
	reconnectMinMs?: number | string;
	reconnectMaxMs?: number | string;
	reconnectMaxAttempts?: number;
	reconnectJitter?: number;
	commandTimeoutMs?: number | string;
	maxFrameBytes?: number | string;
	logger?: PiBusLogger;
}

export interface ReconnectingEvent {
	attempt: number;
	delay: number;
}

export interface PiBusClientErrorEvent {
	id?: string;
	code?: string;
	error: string;
	fatal?: boolean;
	cause?: unknown;
}

export interface PiBusClientEvents {
	online: [Welcome];
	offline: [Error?];
	connect_error: [Error];
	reconnecting: [ReconnectingEvent];
	reconnect_failed: [Error];
	bus_event: [BusEvent];
	bus_error: [PiBusClientErrorEvent];
	presence: [Presence];
	history: [BusEvent[]];
	peers: [Peer[]];
	ack: [Ack];
}

export type PiBusClientEventName = keyof PiBusClientEvents | `topic:${string}`;
type PiBusClientEventArgs<K extends PiBusClientEventName> = K extends keyof PiBusClientEvents ? PiBusClientEvents[K] : K extends `topic:${string}` ? [BusEvent] : never;

type CommandFrameCase = "publish" | "subscribe" | "historyRequest" | "peersRequest" | "pong";

type CommandResultByFrame = {
	publish: Ack;
	subscribe: Ack;
	historyRequest: HistoryResponse;
	peersRequest: PeersResponse;
	pong: Ack;
};

interface PendingCommand {
	command: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timeout: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export class PiBusClient extends EventEmitter {
	readonly host: string;
	readonly port: number;
	readonly socketPath?: string;
	readonly token?: string;
	readonly commandTimeoutMs: number;
	readonly maxFrameBytes: number;
	readonly reconnectMinMs: number;
	readonly reconnectMaxMs: number;
	readonly reconnectMaxAttempts: number;
	readonly reconnectJitter: number;
	readonly logger?: PiBusLogger;

	agent = sanitizeAgent();
	rooms: string[] = [];
	topics: string[] = [];
	reconnect: boolean;
	isOnline = false;
	isClosed = true;
	isConnecting = false;
	connectionId?: string;
	serverId?: string;
	assignedAgentId?: string;
	peers: Peer[] = [];

	#socket?: net.Socket;
	#buffer: Buffer = Buffer.alloc(0);
	#pending = new Map<string, PendingCommand>();
	#reconnectTimer?: ReturnType<typeof setTimeout>;
	#reconnectAttempt = 0;
	#connectPromise?: Promise<this>;
	#resolveConnect?: (client: this) => void;
	#rejectConnect?: (error: Error) => void;
	#lastSocketError?: Error;

	constructor(options: PiBusClientOptions = {}) {
		super();
		this.host = options.host ?? DEFAULT_HOST;
		this.port = portNumber(options.port, DEFAULT_PORT, "port");
		this.socketPath = emptyToUndefined(options.socketPath);
		this.token = emptyToUndefined(options.token);
		this.agent = sanitizeAgent({
			id: options.agent?.id,
			name: options.agent?.name,
			cwd: options.agent?.cwd,
			sessionId: options.agent?.sessionId,
			sessionFile: options.agent?.sessionFile,
			model: options.agent?.model,
			pid: options.agent?.pid ?? process.pid,
			metadata: options.agent?.metadata,
		});
		this.rooms = normalizeRooms(options.rooms);
		this.topics = normalizeTopics(options.topics);
		this.reconnect = options.reconnect !== false;
		this.reconnectMinMs = positiveInteger(options.reconnectMinMs, DEFAULT_RECONNECT_MIN_MS, "reconnectMinMs");
		this.reconnectMaxMs = positiveInteger(options.reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS, "reconnectMaxMs");
		if (this.reconnectMaxMs < this.reconnectMinMs) throw new TypeError("reconnectMaxMs must be greater than or equal to reconnectMinMs");
		this.reconnectMaxAttempts = normalizeReconnectAttempts(options.reconnectMaxAttempts);
		this.reconnectJitter = normalizeJitter(options.reconnectJitter);
		this.commandTimeoutMs = positiveInteger(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, "commandTimeoutMs");
		this.maxFrameBytes = positiveInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, "maxFrameBytes");
		this.logger = options.logger;
	}

	on<K extends PiBusClientEventName>(eventName: K, listener: (...args: PiBusClientEventArgs<K>) => void): this;
	on(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.on(eventName, listener);
	}

	once<K extends PiBusClientEventName>(eventName: K, listener: (...args: PiBusClientEventArgs<K>) => void): this;
	once(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.once(eventName, listener);
	}

	off<K extends PiBusClientEventName>(eventName: K, listener: (...args: PiBusClientEventArgs<K>) => void): this;
	off(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.off(eventName, listener);
	}

	connect(options: CommandOptions = {}): Promise<this> {
		throwIfAborted(options.signal);
		if (this.isOnline) return Promise.resolve(this);
		if (this.#connectPromise) return withAbort(this.#connectPromise, options.signal);
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = undefined;
		}

		this.isClosed = false;
		this.#connectPromise = new Promise<this>((resolve, reject) => {
			this.#resolveConnect = resolve;
			this.#rejectConnect = reject;
			try {
				this.#connectOnce();
			} catch (error) {
				this.#settleConnectError(toError(error, "Failed to start PiBus connection"));
			}
		}).finally(() => {
			this.#connectPromise = undefined;
			this.#resolveConnect = undefined;
			this.#rejectConnect = undefined;
		});

		return withAbort(this.#connectPromise, options.signal);
	}

	close(): void {
		this.isClosed = true;
		this.reconnect = false;
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		const error = new Error("PiBus client closed");
		this.#settleConnectError(error);
		this.#rejectPending(error);
		this.#socket?.destroy();
		this.#socket = undefined;
		this.#buffer = Buffer.alloc(0);
		this.isOnline = false;
		this.isConnecting = false;
		this.connectionId = undefined;
	}

	publish(event: PublishEventInput, options: PublishOptions = {}): Promise<Ack> {
		return this.#command("publish", { event: normalizeBusEvent(event), includeSelf: Boolean(options.includeSelf) }, "publish", options.signal);
	}

	subscribe(options: SubscribeOptions = {}): Promise<Ack> {
		if (options.rooms !== undefined) this.rooms = normalizeRooms(options.rooms);
		if (options.topics !== undefined) this.topics = normalizeTopics(options.topics);
		return this.#command("subscribe", { rooms: this.rooms, topics: this.topics }, "subscribe", options.signal);
	}

	requestHistory(filter: HistoryFilter = {}): Promise<HistoryResponse> {
		return this.#command(
			"historyRequest",
			{
				room: filter.room ?? "",
				topic: filter.topic ?? "",
				since: filter.since ?? "",
				limit: typeof filter.limit === "number" && Number.isFinite(filter.limit) ? Math.max(0, Math.trunc(filter.limit)) : 0,
			},
			"history",
			filter.signal,
		);
	}

	requestPeers(options: CommandOptions = {}): Promise<PeersResponse> {
		return this.#command("peersRequest", {}, "peers", options.signal);
	}

	#connectOnce(): void {
		this.#socket?.destroy();
		this.isConnecting = true;
		this.isOnline = false;
		this.#lastSocketError = undefined;
		this.#buffer = Buffer.alloc(0);
		this.connectionId = undefined;

		const socket = this.socketPath ? net.connect({ path: this.socketPath }) : net.connect({ host: this.host, port: this.port });
		this.#socket = socket;

		socket.on("connect", () => {
			this.#log("connected");
			const sent = this.#send("hello", {
				id: makeId("cmd"),
				protocol: PROTOCOL_VERSION,
				token: this.token ?? "",
				agent: this.agent,
				rooms: this.rooms,
				topics: this.topics,
				client: { hostname: os.hostname(), pid: process.pid, connectedAt: nowIso() },
			});
			if (!sent) {
				const error = new Error("Failed to write PiBus hello");
				this.#settleConnectError(error);
				socket.destroy(error);
			}
		});
		socket.on("data", (chunk: Buffer | string) => this.#onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		socket.on("error", (error: Error) => {
			this.#lastSocketError = error;
			this.#log("socket error", error.message);
			if (!this.isOnline) this.#settleConnectError(error);
		});
		socket.on("close", () => this.#onClose(socket));
	}

	#onData(chunk: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		try {
			const decoded = decodeFrames(this.#buffer, this.maxFrameBytes);
			this.#buffer = decoded.rest;
			for (const frame of decoded.frames) this.#handleFrame(frame);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#emit("bus_error", { error: `Invalid protobuf frame from server: ${message}`, fatal: true, cause: error });
			this.#socket?.destroy(error instanceof Error ? error : undefined);
		}
	}

	#handleFrame(frame: Frame): void {
		const body = frame.body;
		if (!body.case) {
			this.#emit("bus_error", { error: "Empty protobuf frame from server" });
			return;
		}

		switch (body.case) {
			case "welcome":
				this.#handleWelcome(body.value);
				break;
			case "event":
				this.#emit("bus_event", body.value);
				if (body.value.topic) this.#emit(`topic:${body.value.topic}`, body.value);
				break;
			case "presence":
				this.#updatePresence(body.value);
				this.#emit("presence", body.value);
				break;
			case "historyResponse":
				this.#resolvePending(body.value.id, body.value);
				this.#emit("history", body.value.events);
				break;
			case "peersResponse":
				this.peers = body.value.peers;
				this.#resolvePending(body.value.id, body.value);
				this.#emit("peers", this.peers);
				break;
			case "ack":
				this.#resolvePending(body.value.id, body.value);
				this.#emit("ack", body.value);
				break;
			case "ping":
				this.#send("pong", { id: body.value.id, now: nowIso() });
				break;
			case "pong":
				this.#resolvePending(body.value.id, body.value);
				break;
			case "error":
				this.#handleError(body.value);
				break;
			case "hello":
			case "publish":
			case "subscribe":
			case "historyRequest":
			case "peersRequest":
				this.#emit("bus_error", { error: `Unexpected server frame: ${body.case}` });
				break;
		}
	}

	#handleWelcome(message: Welcome): void {
		if (message.protocol !== PROTOCOL_VERSION) {
			const error = new Error(`Unsupported PiBus protocol ${message.protocol || "(missing)"}; expected ${PROTOCOL_VERSION}`);
			this.#settleConnectError(error);
			this.#emit("bus_error", { error: error.message, fatal: true });
			this.#socket?.destroy(error);
			return;
		}
		if (!message.connectionId || !message.serverId || !message.agentId) {
			const error = new Error("Malformed PiBus welcome frame");
			this.#settleConnectError(error);
			this.#emit("bus_error", { error: error.message, fatal: true });
			this.#socket?.destroy(error);
			return;
		}

		this.isOnline = true;
		this.isConnecting = false;
		this.#reconnectAttempt = 0;
		this.connectionId = message.connectionId;
		this.serverId = message.serverId;
		this.assignedAgentId = message.agentId;
		this.rooms = normalizeRooms(message.rooms);
		this.topics = normalizeTopics(message.topics);
		this.peers = message.peers;
		this.#settleConnectSuccess();
		this.#emit("online", message);
	}

	#handleError(message: ServerErrorFrame): void {
		const error = new Error(message.error || "PiBus server error");
		if (message.id && this.#pending.has(message.id)) this.#rejectPendingId(message.id, error);
		else this.#emit("bus_error", { id: message.id || undefined, code: message.code || undefined, error: error.message, fatal: message.fatal });
		if (message.fatal) {
			if (!this.isOnline) this.#settleConnectError(error);
			this.#socket?.destroy(error);
		}
	}

	#updatePresence(message: Presence): void {
		const peer = message.peer;
		if (!peer?.connectionId) return;
		if (message.action === "leave") {
			this.peers = this.peers.filter((item) => item.connectionId !== peer.connectionId);
			return;
		}
		const index = this.peers.findIndex((item) => item.connectionId === peer.connectionId);
		if (index >= 0) this.peers[index] = peer;
		else this.peers.push(peer);
	}

	#onClose(socket: net.Socket): void {
		if (this.#socket !== socket) return;
		const wasOnline = this.isOnline;
		const wasConnecting = this.isConnecting || Boolean(this.#connectPromise);
		const closeError = this.#lastSocketError;
		this.isOnline = false;
		this.isConnecting = false;
		this.#socket = undefined;
		this.connectionId = undefined;
		this.#buffer = Buffer.alloc(0);
		this.#rejectPending(closeError ?? new Error("PiBus connection closed"));
		if (wasConnecting && !wasOnline) this.#settleConnectError(closeError ?? new Error("PiBus connection closed before welcome"));
		if (wasOnline) this.#emit("offline", closeError);
		if (!this.isClosed && this.reconnect) this.#scheduleReconnect();
	}

	#scheduleReconnect(): void {
		if (this.#reconnectTimer) return;
		if (Number.isFinite(this.reconnectMaxAttempts) && this.#reconnectAttempt >= this.reconnectMaxAttempts) {
			const error = new Error(`PiBus reconnect attempts exhausted after ${this.#reconnectAttempt} attempt(s)`);
			this.reconnect = false;
			this.#emit("reconnect_failed", error);
			this.#emit("bus_error", { error: error.message, fatal: true });
			return;
		}

		const attempt = this.#reconnectAttempt + 1;
		const baseDelay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** (attempt - 1));
		const delay = Math.round(applyJitter(baseDelay, this.reconnectJitter));
		this.#reconnectAttempt = attempt;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			if (!this.isClosed) this.#connectOnce();
		}, delay);
		this.#reconnectTimer.unref?.();
		this.#emit("reconnecting", { delay, attempt });
	}

	#command<C extends keyof CommandResultByFrame & CommandFrameCase>(caseName: C, value: Omit<FrameValue<C>, "id"> & { id?: string }, command: string, signal?: AbortSignal): Promise<CommandResultByFrame[C]> {
		throwIfAborted(signal);
		if (!this.isOnline || !this.#socket || this.#socket.destroyed) {
			return Promise.reject(new Error("PiBus is not connected"));
		}
		const id = value.id || makeId("cmd");
		const frameValue = { ...value, id } as FrameValue<C>;
		return new Promise<CommandResultByFrame[C]>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#rejectPendingId(id, new Error(`PiBus command timed out: ${command}`));
			}, this.commandTimeoutMs);
			timeout.unref?.();
			const entry: PendingCommand = {
				command,
				resolve: (result: unknown) => resolve(result as CommandResultByFrame[C]),
				reject,
				timeout,
				signal,
			};
			if (signal) {
				entry.onAbort = () => this.#rejectPendingId(id, abortError(signal));
				signal.addEventListener("abort", entry.onAbort, { once: true });
			}
			this.#pending.set(id, entry);
			if (!this.#send(caseName, frameValue)) this.#rejectPendingId(id, new Error(`Failed to write PiBus command: ${command}`));
		});
	}

	#send<C extends FrameCase>(caseName: C, value: FrameValue<C>): boolean {
		const socket = this.#socket;
		if (!socket || socket.destroyed || !socket.writable) return false;
		try {
			socket.write(encodeFrame(caseName, value));
			return true;
		} catch (error) {
			this.#emit("bus_error", { error: `Failed to encode/write PiBus ${caseName} frame`, cause: error });
			return false;
		}
	}

	#resolvePending(id: string, value: unknown): boolean {
		if (!id) return false;
		const pending = this.#pending.get(id);
		if (!pending) return false;
		this.#pending.delete(id);
		this.#clearPending(pending);
		pending.resolve(value);
		return true;
	}

	#rejectPendingId(id: string, error: Error): boolean {
		const pending = this.#pending.get(id);
		if (!pending) return false;
		this.#pending.delete(id);
		this.#clearPending(pending);
		pending.reject(error);
		return true;
	}

	#rejectPending(error: Error): void {
		for (const id of [...this.#pending.keys()]) this.#rejectPendingId(id, error);
	}

	#clearPending(pending: PendingCommand): void {
		clearTimeout(pending.timeout);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
	}

	#settleConnectSuccess(): void {
		this.#resolveConnect?.(this);
		this.#resolveConnect = undefined;
		this.#rejectConnect = undefined;
	}

	#settleConnectError(error: Error): void {
		const reject = this.#rejectConnect;
		this.#resolveConnect = undefined;
		this.#rejectConnect = undefined;
		if (reject) {
			reject(error);
			this.#emit("connect_error", error);
		}
	}

	#emit<K extends PiBusClientEventName>(eventName: K, ...args: PiBusClientEventArgs<K>): boolean {
		return super.emit(eventName, ...args);
	}

	#log(...args: unknown[]): void {
		this.logger?.(...args);
	}
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(abortError(signal));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
	return toError(signal.reason, "PiBus operation aborted");
}

function toError(error: unknown, fallback: string): Error {
	return error instanceof Error ? error : new Error(error === undefined ? fallback : String(error));
}

function emptyToUndefined(value: string | undefined): string | undefined {
	return value && value.length > 0 ? value : undefined;
}

function normalizeReconnectAttempts(value: number | undefined): number {
	if (value === undefined) return Number.POSITIVE_INFINITY;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) throw new TypeError("reconnectMaxAttempts must be a non-negative integer");
	return value;
}

function normalizeJitter(value: number | undefined): number {
	if (value === undefined) return DEFAULT_RECONNECT_JITTER;
	const numberValue = finiteNumber(value, DEFAULT_RECONNECT_JITTER, "reconnectJitter");
	if (numberValue < 0 || numberValue > 1) throw new TypeError("reconnectJitter must be between 0 and 1");
	return numberValue;
}

function applyJitter(delay: number, ratio: number): number {
	if (ratio <= 0 || delay <= 0) return delay;
	const min = 1 - ratio;
	return delay * (min + Math.random() * ratio);
}
