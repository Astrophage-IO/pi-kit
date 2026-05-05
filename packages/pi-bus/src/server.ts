import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import { create } from "@bufbuild/protobuf";
import {
	PeerRefSchema,
	PresenceSchema,
	type BusEvent,
	type Frame,
	type Hello,
	type HistoryRequest,
	type Peer,
	type Presence,
	type Publish,
	type Subscribe,
} from "./gen/pi_bus/v1/pi_bus_pb.ts";
import {
	DEFAULT_HOST,
	DEFAULT_PORT,
	DEFAULT_ROOM,
	DEFAULT_TOPIC,
	PROTOCOL_VERSION,
	compactPeer,
	makeId,
	matchTopic,
	normalizeBusEvent,
	normalizeRooms,
	normalizeTarget,
	normalizeTopics,
	nowIso,
	portNumber,
	positiveInteger,
	sanitizeAgent,
} from "./protocol.ts";
import { decodeFrames, encodeFrame, type FrameCase, type FrameValue } from "./wire.ts";

const DEFAULT_HISTORY_LIMIT = 500;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SOCKET_BUFFER_BYTES = 16 * 1024 * 1024;

type ServerState = "idle" | "starting" | "listening" | "closing";

type PresenceAction = "join" | "leave" | "update";

export type PiBusServerLogger = (...args: unknown[]) => void;

export interface PiBusServerOptions {
	host?: string;
	port?: number | string;
	socketPath?: string;
	token?: string;
	historyLimit?: number | string;
	maxFrameBytes?: number | string;
	maxLineBytes?: number | string;
	heartbeatMs?: number | string;
	helloTimeoutMs?: number | string;
	maxSocketBufferBytes?: number | string;
	serverId?: string;
	verbose?: boolean;
	logger?: PiBusServerLogger;
}

export interface PiBusClientErrorEvent {
	connectionId: string;
	agentId?: string;
	error: Error;
}

export interface PiBusServerEvents {
	event: [BusEvent];
	presence: [Presence];
	client_error: [PiBusClientErrorEvent];
}

interface ConnectedClient {
	connectionId: string;
	socket: net.Socket;
	authenticated: boolean;
	authAttempts: number;
	agentId?: string;
	name?: string;
	cwd?: string;
	sessionId?: string;
	sessionFile?: string;
	model?: string;
	pid?: number;
	rooms: Set<string>;
	topics: Set<string>;
	connectedAtMs: number;
	lastSeenAtMs: number;
	buffer: Buffer;
	helloTimer?: ReturnType<typeof setTimeout>;
	closing: boolean;
}

export class PiBusServer extends EventEmitter {
	readonly host: string;
	readonly port: number;
	readonly socketPath?: string;
	readonly token?: string;
	readonly historyLimit: number;
	readonly maxFrameBytes: number;
	readonly heartbeatMs: number;
	readonly helloTimeoutMs: number;
	readonly maxSocketBufferBytes: number;
	readonly serverId: string;
	readonly verbose: boolean;
	readonly logger?: PiBusServerLogger;

	#server: net.Server;
	#clients = new Map<string, ConnectedClient>();
	#history: BusEvent[] = [];
	#heartbeatTimer?: ReturnType<typeof setInterval>;
	#listenPromise?: Promise<this>;
	#state: ServerState = "idle";

	constructor(options: PiBusServerOptions = {}) {
		super();
		this.host = options.host ?? DEFAULT_HOST;
		this.port = portNumber(options.port, DEFAULT_PORT, "port", true);
		this.socketPath = emptyToUndefined(options.socketPath);
		this.token = emptyToUndefined(options.token);
		this.historyLimit = positiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, "historyLimit");
		this.maxFrameBytes = positiveInteger(options.maxFrameBytes ?? options.maxLineBytes, DEFAULT_MAX_FRAME_BYTES, "maxFrameBytes");
		this.heartbeatMs = positiveInteger(options.heartbeatMs, DEFAULT_HEARTBEAT_MS, "heartbeatMs");
		this.helloTimeoutMs = positiveInteger(options.helloTimeoutMs, DEFAULT_HELLO_TIMEOUT_MS, "helloTimeoutMs");
		this.maxSocketBufferBytes = positiveInteger(options.maxSocketBufferBytes, DEFAULT_MAX_SOCKET_BUFFER_BYTES, "maxSocketBufferBytes");
		this.serverId = options.serverId ?? `${os.hostname()}-${process.pid}-${makeId("server")}`;
		this.verbose = Boolean(options.verbose);
		this.logger = options.logger;
		this.#server = net.createServer((socket) => this.#onConnection(socket));
	}

	on<K extends keyof PiBusServerEvents>(eventName: K, listener: (...args: PiBusServerEvents[K]) => void): this;
	on(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.on(eventName, listener);
	}

	once<K extends keyof PiBusServerEvents>(eventName: K, listener: (...args: PiBusServerEvents[K]) => void): this;
	once(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.once(eventName, listener);
	}

	off<K extends keyof PiBusServerEvents>(eventName: K, listener: (...args: PiBusServerEvents[K]) => void): this;
	off(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.off(eventName, listener);
	}

	listen(): Promise<this> {
		if (this.#state === "listening") return Promise.resolve(this);
		if (this.#state === "starting" && this.#listenPromise) return this.#listenPromise;
		if (this.#state === "closing") return Promise.reject(new Error("PiBus server is closing"));

		this.#state = "starting";
		this.#listenPromise = new Promise<this>((resolve, reject) => {
			const cleanup = () => {
				this.#server.off("error", onError);
				this.#server.off("listening", onListening);
			};
			const onError = (error: Error) => {
				cleanup();
				this.#state = "idle";
				this.#listenPromise = undefined;
				reject(error);
			};
			const onListening = () => {
				cleanup();
				this.#state = "listening";
				this.#listenPromise = undefined;
				this.#startHeartbeat();
				resolve(this);
			};
			this.#server.once("error", onError);
			this.#server.once("listening", onListening);
			try {
				if (this.socketPath) this.#server.listen(this.socketPath);
				else this.#server.listen(this.port, this.host);
			} catch (error) {
				onError(error instanceof Error ? error : new Error(String(error)));
			}
		});
		return this.#listenPromise;
	}

	async close(): Promise<void> {
		if (this.#state === "starting" && this.#listenPromise) {
			try {
				await this.#listenPromise;
			} catch {
				// A failed listen already reset state to idle.
			}
		}
		if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = undefined;
		this.#state = "closing";
		for (const client of [...this.#clients.values()]) {
			client.closing = true;
			clearTimeout(client.helloTimer);
			client.socket.destroy();
		}

		await new Promise<void>((resolve, reject) => {
			if (!this.#server.listening) {
				resolve();
				return;
			}
			this.#server.close((error?: Error) => {
				if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
				else resolve();
			});
		});

		this.#clients.clear();
		this.#state = "idle";
	}

	address(): net.AddressInfo | string | null {
		return this.#server.address();
	}

	getPeers(): Peer[] {
		return [...this.#clients.values()].filter((client) => client.authenticated).map((client) => this.#compactPeer(client));
	}

	#startHeartbeat(): void {
		if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = setInterval(() => this.#heartbeat(), this.heartbeatMs);
		this.#heartbeatTimer.unref?.();
	}

	#onConnection(socket: net.Socket): void {
		const connectionId = makeId("conn");
		const now = Date.now();
		const client: ConnectedClient = {
			connectionId,
			socket,
			authenticated: false,
			authAttempts: 0,
			rooms: new Set([DEFAULT_ROOM]),
			topics: new Set(["*"]),
			connectedAtMs: now,
			lastSeenAtMs: now,
			buffer: Buffer.alloc(0),
			closing: false,
		};
		client.helloTimer = setTimeout(() => {
			if (!client.authenticated && !client.closing) this.#sendError(client, "", "PiBus hello timeout", true, "hello_timeout");
		}, this.helloTimeoutMs);
		client.helloTimer.unref?.();

		this.#clients.set(connectionId, client);
		this.#log("connection", connectionId, socket.remoteAddress ?? "local");

		socket.on("data", (chunk: Buffer | string) => this.#onData(client, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		socket.on("close", () => this.#onClose(client));
		socket.on("error", (error: Error) => this.#onSocketError(client, error));
	}

	#onSocketError(client: ConnectedClient, error: Error): void {
		this.#log("socket error", client.connectionId, error.message);
		this.#emit("client_error", { connectionId: client.connectionId, agentId: client.agentId, error });
	}

	#onData(client: ConnectedClient, chunk: Buffer): void {
		if (client.closing || client.socket.destroyed) return;
		client.buffer = Buffer.concat([client.buffer, chunk]);
		try {
			const decoded = decodeFrames(client.buffer, this.maxFrameBytes);
			client.buffer = decoded.rest;
			for (const frame of decoded.frames) this.#handleFrame(client, frame);
		} catch (error) {
			client.buffer = Buffer.alloc(0);
			client.closing = true;
			const message = error instanceof Error ? error.message : String(error);
			this.#sendError(client, "", message, true, "invalid_frame");
		}
	}

	#handleFrame(client: ConnectedClient, frame: Frame): void {
		const body = frame.body;
		if (!body.case) {
			this.#sendError(client, "", "Empty protobuf frame", false, "invalid_frame");
			return;
		}
		client.lastSeenAtMs = Date.now();

		switch (body.case) {
			case "hello":
				this.#handleHello(client, body.value);
				break;
			case "publish":
				this.#requireAuth(client, body.value.id, () => this.#handlePublish(client, body.value));
				break;
			case "subscribe":
				this.#requireAuth(client, body.value.id, () => this.#handleSubscribe(client, body.value));
				break;
			case "historyRequest":
				this.#requireAuth(client, body.value.id, () => this.#handleHistory(client, body.value));
				break;
			case "peersRequest":
				this.#requireAuth(client, body.value.id, () => this.#handlePeers(client, body.value.id));
				break;
			case "ping":
				this.#write(client, "pong", { id: body.value.id, now: nowIso() });
				break;
			case "pong":
				break;
			case "welcome":
			case "historyResponse":
			case "peersResponse":
			case "event":
			case "presence":
			case "ack":
			case "error":
				this.#sendError(client, frameId(body.value), `Unexpected client frame: ${body.case}`, false, "unexpected_frame");
				break;
		}
	}

	#requireAuth(client: ConnectedClient, id: string, fn: () => void): void {
		if (!client.authenticated) {
			this.#sendError(client, id, "Client must send hello before using the bus", false, "not_authenticated");
			return;
		}
		fn();
	}

	#handleHello(client: ConnectedClient, message: Hello): void {
		client.authAttempts += 1;
		if (client.authenticated) {
			this.#sendError(client, message.id, "Client is already authenticated", true, "already_authenticated");
			return;
		}
		if (message.protocol !== PROTOCOL_VERSION) {
			this.#sendError(client, message.id, `Unsupported protocol ${message.protocol || "(missing)"}; expected ${PROTOCOL_VERSION}`, true, "unsupported_protocol");
			return;
		}
		if (this.token && message.token !== this.token) {
			this.#sendError(client, message.id, "Invalid PiBus token", true, "invalid_token");
			return;
		}

		const agent = sanitizeAgent(message.agent);
		if (this.#isDuplicateAgentId(client.connectionId, agent.id)) {
			this.#sendError(client, message.id, `Agent id is already connected: ${agent.id}`, true, "duplicate_agent_id");
			return;
		}

		client.agentId = agent.id;
		client.name = agent.name;
		client.cwd = emptyToUndefined(agent.cwd);
		client.sessionId = emptyToUndefined(agent.sessionId);
		client.sessionFile = emptyToUndefined(agent.sessionFile);
		client.model = emptyToUndefined(agent.model);
		client.pid = agent.pid > 0 ? agent.pid : undefined;
		client.rooms = new Set(normalizeRooms(message.rooms));
		client.topics = new Set(normalizeTopics(message.topics));
		client.authenticated = true;
		client.lastSeenAtMs = Date.now();
		clearTimeout(client.helloTimer);

		this.#write(client, "welcome", {
			id: message.id,
			protocol: PROTOCOL_VERSION,
			serverId: this.serverId,
			connectionId: client.connectionId,
			agentId: client.agentId,
			rooms: [...client.rooms],
			topics: [...client.topics],
			now: nowIso(),
			peers: this.getPeers(),
		});
		this.#broadcastPresence("join", client);
		this.#log("hello", client.agentId, client.name, [...client.rooms].join(","), [...client.topics].join(","));
	}

	#handlePublish(client: ConnectedClient, message: Publish): void {
		const defaultRoom = this.#defaultRoomFor(client);
		const from = create(PeerRefSchema, {
			connectionId: client.connectionId,
			agentId: client.agentId ?? "",
			name: client.name ?? client.agentId ?? client.connectionId,
		});
		const event = normalizeBusEvent(message.event, { defaultRoom, defaultTopic: DEFAULT_TOPIC, from, createdAt: nowIso() });
		if (!client.rooms.has("*") && !client.rooms.has(event.room)) {
			this.#sendError(client, message.id, `Client is not joined to room: ${event.room}`, false, "room_not_joined");
			return;
		}

		this.#storeHistory(event);
		const recipients = this.#deliverEvent(event, {
			sourceClient: client,
			includeSelf: message.includeSelf,
		});
		this.#write(client, "ack", { id: message.id, command: "publish", eventId: event.id, recipients });
		this.#emit("event", event);
		this.#log("publish", event.id, event.room, event.topic, "recipients", recipients);
	}

	#handleSubscribe(client: ConnectedClient, message: Subscribe): void {
		if (message.rooms.length > 0) client.rooms = new Set(normalizeRooms(message.rooms));
		if (message.topics.length > 0) client.topics = new Set(normalizeTopics(message.topics));
		this.#write(client, "ack", {
			id: message.id,
			command: "subscribe",
			rooms: [...client.rooms],
			topics: [...client.topics],
		});
		this.#broadcastPresence("update", client);
	}

	#handleHistory(client: ConnectedClient, message: HistoryRequest): void {
		let events = this.#history;
		const requestedRoom = message.room.trim() || undefined;
		if (requestedRoom && !client.rooms.has("*") && !client.rooms.has(requestedRoom)) {
			this.#sendError(client, message.id, `Client is not joined to room: ${requestedRoom}`, false, "room_not_joined");
			return;
		}
		if (requestedRoom) events = events.filter((event) => event.room === requestedRoom);
		else if (!client.rooms.has("*")) events = events.filter((event) => client.rooms.has(event.room));
		if (message.topic.trim()) events = events.filter((event) => matchTopic(message.topic, event.topic));
		if (message.since.trim()) {
			const since = Date.parse(message.since);
			if (!Number.isNaN(since)) events = events.filter((event) => Date.parse(event.createdAt) > since);
		}
		const limit = Math.max(1, Math.min(message.limit || 50, this.historyLimit));
		this.#write(client, "historyResponse", { id: message.id, events: events.slice(-limit) });
	}

	#handlePeers(client: ConnectedClient, id: string): void {
		this.#write(client, "peersResponse", { id, peers: this.getPeers() });
	}

	#storeHistory(event: BusEvent): void {
		this.#history.push(event);
		if (this.#history.length > this.historyLimit) this.#history.splice(0, this.#history.length - this.historyLimit);
	}

	#deliverEvent(event: BusEvent, { sourceClient, includeSelf }: { sourceClient: ConnectedClient; includeSelf: boolean }): number {
		let recipients = 0;
		for (const client of this.#clients.values()) {
			if (!client.authenticated) continue;
			if (!includeSelf && client.connectionId === sourceClient.connectionId) continue;
			if (!this.#clientWantsEvent(client, event)) continue;
			if (this.#write(client, "event", event)) recipients++;
		}
		return recipients;
	}

	#clientWantsEvent(client: ConnectedClient, event: BusEvent): boolean {
		const target = normalizeTarget(event.target);
		if (target.length > 0) {
			return target.includes(client.agentId ?? "") || target.includes(client.name ?? "") || target.includes(client.connectionId);
		}
		if (!client.rooms.has("*") && !client.rooms.has(event.room)) return false;
		for (const topic of client.topics) if (matchTopic(topic, event.topic)) return true;
		return false;
	}

	#broadcastPresence(action: PresenceAction, client: ConnectedClient): void {
		if (!client.authenticated || this.#state === "closing") return;
		const record = create(PresenceSchema, { action, peer: this.#compactPeer(client), now: nowIso() });
		for (const other of this.#clients.values()) {
			if (!other.authenticated || other.connectionId === client.connectionId) continue;
			this.#write(other, "presence", record);
		}
		this.#emit("presence", record);
	}

	#onClose(client: ConnectedClient): void {
		client.closing = true;
		clearTimeout(client.helloTimer);
		const existed = this.#clients.delete(client.connectionId);
		if (existed && client.authenticated) this.#broadcastPresence("leave", client);
		this.#log("disconnect", client.connectionId, client.agentId ?? "unknown");
	}

	#sendError(client: ConnectedClient, id: string, error: string, fatal = false, code = "server_error"): void {
		this.#write(client, "error", { id, error, fatal, code });
		if (fatal) {
			client.closing = true;
			client.socket.destroy();
		}
	}

	#write<C extends FrameCase>(client: ConnectedClient, caseName: C, value: FrameValue<C>): boolean {
		if (client.socket.destroyed || !client.socket.writable) return false;
		try {
			client.socket.write(encodeFrame(caseName, value));
			if (client.socket.writableLength > this.maxSocketBufferBytes) {
				const error = new Error(`PiBus socket buffer exceeded ${this.maxSocketBufferBytes} bytes`);
				this.#onSocketError(client, error);
				client.closing = true;
				client.socket.destroy(error);
				return false;
			}
			return true;
		} catch (error) {
			const realError = error instanceof Error ? error : new Error(String(error));
			this.#onSocketError(client, realError);
			client.closing = true;
			client.socket.destroy(realError);
			return false;
		}
	}

	#heartbeat(): void {
		const now = Date.now();
		for (const client of this.#clients.values()) {
			if (client.closing) continue;
			if (!client.authenticated) {
				if (now - client.connectedAtMs > this.helloTimeoutMs) this.#sendError(client, "", "PiBus hello timeout", true, "hello_timeout");
				continue;
			}
			if (now - client.lastSeenAtMs > this.heartbeatMs * 4) {
				client.closing = true;
				client.socket.destroy();
				continue;
			}
			this.#write(client, "ping", { now: nowIso() });
		}
	}

	#compactPeer(client: ConnectedClient): Peer {
		return compactPeer({
			connectionId: client.connectionId,
			agentId: client.agentId,
			name: client.name,
			rooms: client.rooms,
			topics: client.topics,
			cwd: client.cwd,
			sessionId: client.sessionId,
			sessionFile: client.sessionFile,
			model: client.model,
			pid: client.pid,
			connectedAt: new Date(client.connectedAtMs).toISOString(),
			lastSeenAt: new Date(client.lastSeenAtMs).toISOString(),
		});
	}

	#defaultRoomFor(client: ConnectedClient): string {
		return client.rooms.has(DEFAULT_ROOM) ? DEFAULT_ROOM : [...client.rooms][0] ?? DEFAULT_ROOM;
	}

	#isDuplicateAgentId(connectionId: string, agentId: string): boolean {
		for (const client of this.#clients.values()) {
			if (client.connectionId !== connectionId && client.authenticated && client.agentId === agentId) return true;
		}
		return false;
	}

	#emit<K extends keyof PiBusServerEvents>(eventName: K, ...args: PiBusServerEvents[K]): boolean {
		return super.emit(eventName, ...args);
	}

	#log(...args: unknown[]): void {
		if (this.logger) this.logger(...args);
		else if (this.verbose) console.log("[pi-bus]", ...args);
	}
}

export async function createAndListen(options: PiBusServerOptions = {}): Promise<PiBusServer> {
	const server = new PiBusServer(options);
	await server.listen();
	return server;
}

function emptyToUndefined(value: string | undefined): string | undefined {
	return value && value.length > 0 ? value : undefined;
}

function frameId(value: unknown): string {
	if (typeof value === "object" && value !== null && "id" in value) {
		const id = (value as { id?: unknown }).id;
		return typeof id === "string" ? id : "";
	}
	return "";
}
