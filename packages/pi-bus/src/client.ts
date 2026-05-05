import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import {
	DEFAULT_HOST,
	DEFAULT_PORT,
	PROTOCOL_VERSION,
	frame,
	makeId,
	normalizeRooms,
	normalizeTopics,
	nowIso,
	parseJsonLine,
	sanitizeAgent,
} from "./protocol.ts";

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export class PiBusClient extends EventEmitter {
	[key: string]: any;

	constructor(options: any = {}) {
		super();
		this.host = options.host ?? DEFAULT_HOST;
		this.port = Number(options.port ?? DEFAULT_PORT);
		this.socketPath = options.socketPath;
		this.token = options.token;
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
		this.reconnectMinMs = Number(options.reconnectMinMs ?? 500);
		this.reconnectMaxMs = Number(options.reconnectMaxMs ?? 10_000);
		this.commandTimeoutMs = Number(options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
		this.logger = options.logger;
		this.socket = undefined;
		this.buffer = "";
		this.isOnline = false;
		this.isClosed = false;
		this.isConnecting = false;
		this.connectionId = undefined;
		this.serverId = undefined;
		this.pending = new Map();
		this.reconnectTimer = undefined;
		this.reconnectAttempt = 0;
		this.peers = [];
	}

	connect() {
		if (this.isOnline) return Promise.resolve(this);
		if (this.isConnecting) {
			return new Promise((resolve, reject) => {
				const cleanup = () => {
					this.off("online", onOnline);
					this.off("connect_error", onError);
				};
				const onOnline = () => {
					cleanup();
					resolve(this);
				};
				const onError = (error) => {
					cleanup();
					reject(error);
				};
				this.once("online", onOnline);
				this.once("connect_error", onError);
			});
		}
		this.isClosed = false;
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				this.off("online", onOnline);
				this.off("connect_error", onError);
			};
			const onOnline = () => {
				cleanup();
				resolve(this);
			};
			const onError = (error) => {
				cleanup();
				reject(error);
			};
			this.once("online", onOnline);
			this.once("connect_error", onError);
			this.#connectOnce();
		});
	}

	close() {
		this.isClosed = true;
		this.reconnect = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.#rejectPending(new Error("PiBus client closed"));
		if (this.socket) this.socket.destroy();
		this.socket = undefined;
		this.isOnline = false;
		this.isConnecting = false;
	}

	publish(event: any, options: any = {}): Promise<any> {
		return this.#command({ type: "publish", event, includeSelf: Boolean(options.includeSelf) });
	}

	subscribe({ rooms, topics }: any = {}): Promise<any> {
		if (rooms !== undefined) this.rooms = normalizeRooms(rooms);
		if (topics !== undefined) this.topics = normalizeTopics(topics);
		return this.#command({ type: "subscribe", rooms: this.rooms, topics: this.topics });
	}

	requestHistory(filter: any = {}): Promise<any> {
		return this.#command({
			type: "history",
			room: filter.room,
			topic: filter.topic,
			since: filter.since,
			limit: filter.limit,
		});
	}

	requestPeers(): Promise<any> {
		return this.#command({ type: "peers" });
	}

	#connectOnce() {
		if (this.socket && !this.socket.destroyed) this.socket.destroy();
		this.isConnecting = true;
		this.buffer = "";
		const socket = this.socketPath ? net.connect({ path: this.socketPath }) : net.connect({ host: this.host, port: this.port });
		this.socket = socket;
		socket.setEncoding("utf8");

		socket.on("connect", () => {
			this.#log("connected");
			this.#send({
				type: "hello",
				id: makeId("cmd"),
				protocol: PROTOCOL_VERSION,
				token: this.token,
				agent: this.agent,
				rooms: this.rooms,
				topics: this.topics,
				client: { hostname: os.hostname(), pid: process.pid, connectedAt: nowIso() },
			});
		});
		socket.on("data", (chunk) => this.#onData(chunk));
		socket.on("error", (error) => {
			this.#log("socket error", error.message);
			if (!this.isOnline) this.emit("connect_error", error);
			else this.emit("offline", error);
		});
		socket.on("close", () => this.#onClose());
	}

	#onData(chunk) {
		this.buffer += chunk;
		while (true) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			const line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			let message;
			try {
				message = parseJsonLine(line);
			} catch (error) {
				this.emit("bus_error", { error: `Invalid JSON from server: ${error.message}` });
				continue;
			}
			if (message !== undefined) this.#handleMessage(message);
		}
	}

	#handleMessage(message: any) {
		switch (message.type) {
			case "welcome":
				this.isOnline = true;
				this.isConnecting = false;
				this.reconnectAttempt = 0;
				this.connectionId = message.connectionId;
				this.serverId = message.serverId;
				this.agent.id = message.agentId ?? this.agent.id;
				this.rooms = normalizeRooms(message.rooms);
				this.topics = normalizeTopics(message.topics);
				this.peers = Array.isArray(message.peers) ? message.peers : [];
				this.emit("online", message);
				break;
			case "event":
				this.emit("bus_event", message.event);
				if (message.event?.topic) this.emit(`topic:${message.event.topic}`, message.event);
				break;
			case "presence":
				this.#updatePresence(message);
				this.emit("presence", message);
				break;
			case "history":
				this.#resolvePending(message.id, message);
				this.emit("history", message.events ?? []);
				break;
			case "peers":
				this.peers = Array.isArray(message.peers) ? message.peers : [];
				this.#resolvePending(message.id, message);
				this.emit("peers", this.peers);
				break;
			case "ack":
				this.#resolvePending(message.id, message);
				this.emit("ack", message);
				break;
			case "ping":
				this.#send({ type: "pong", id: message.id, now: nowIso() });
				break;
			case "pong":
				this.#resolvePending(message.id, message);
				break;
			case "error": {
				const error = new Error(message.error ?? "PiBus server error");
				if (message.id && this.pending.has(message.id)) this.#rejectPendingId(message.id, error);
				else this.emit("bus_error", message);
				if (message.fatal) {
					if (!this.isOnline) this.emit("connect_error", error);
					this.socket?.destroy();
				}
				break;
			}
			default:
				this.emit("bus_error", { error: `Unknown server message type: ${message.type}` });
		}
	}

	#updatePresence(message: any) {
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

	#onClose() {
		const wasOnline = this.isOnline;
		this.isOnline = false;
		this.isConnecting = false;
		this.socket = undefined;
		this.connectionId = undefined;
		this.#rejectPending(new Error("PiBus connection closed"));
		if (wasOnline) this.emit("offline");
		if (!this.isClosed && this.reconnect) this.#scheduleReconnect();
	}

	#scheduleReconnect() {
		if (this.reconnectTimer) return;
		const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** this.reconnectAttempt++);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			if (!this.isClosed) this.#connectOnce();
		}, delay);
		this.reconnectTimer.unref?.();
		this.emit("reconnecting", { delay, attempt: this.reconnectAttempt });
	}

	#command(record: any): Promise<any> {
		if (!this.isOnline || !this.socket || this.socket.destroyed) {
			return Promise.reject(new Error("PiBus is not connected"));
		}
		const id = record.id ?? makeId("cmd");
		const command = { ...record, id };
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`PiBus command timed out: ${record.type}`));
			}, this.commandTimeoutMs);
			timeout.unref?.();
			this.pending.set(id, { resolve, reject, timeout });
			if (!this.#send(command)) {
				this.#rejectPendingId(id, new Error("Failed to write PiBus command"));
			}
		});
	}

	#send(record) {
		if (!this.socket || this.socket.destroyed || !this.socket.writable) return false;
		return this.socket.write(frame(record));
	}

	#resolvePending(id, value) {
		if (!id || !this.pending.has(id)) return false;
		const pending = this.pending.get(id);
		this.pending.delete(id);
		clearTimeout(pending.timeout);
		pending.resolve(value);
		return true;
	}

	#rejectPendingId(id, error) {
		const pending = this.pending.get(id);
		if (!pending) return false;
		this.pending.delete(id);
		clearTimeout(pending.timeout);
		pending.reject(error);
		return true;
	}

	#rejectPending(error) {
		for (const id of this.pending.keys()) this.#rejectPendingId(id, error);
	}

	#log(...args) {
		if (this.logger) this.logger(...args);
	}
}
