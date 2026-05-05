import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import {
	DEFAULT_HOST,
	DEFAULT_PORT,
	DEFAULT_ROOM,
	DEFAULT_TOPIC,
	PROTOCOL_VERSION,
	compactPeer,
	frame,
	isPlainObject,
	makeId,
	matchTopic,
	messageTextFromEvent,
	normalizeRooms,
	normalizeTarget,
	normalizeTopics,
	nowIso,
	parseJsonLine,
} from "./protocol.ts";

const DEFAULT_HISTORY_LIMIT = 500;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 30_000;

export class PiBusServer extends EventEmitter {
	[key: string]: any;

	constructor(options: any = {}) {
		super();
		this.host = options.host ?? DEFAULT_HOST;
		this.port = Number(options.port ?? DEFAULT_PORT);
		this.socketPath = options.socketPath;
		this.token = options.token;
		this.historyLimit = Number(options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
		this.maxLineBytes = Number(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
		this.heartbeatMs = Number(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
		this.serverId = options.serverId ?? `${os.hostname()}-${process.pid}-${makeId("server")}`;
		this.verbose = Boolean(options.verbose);
		this.clients = new Map();
		this.history = [];
		this.server = net.createServer((socket) => this.#onConnection(socket));
		this.heartbeatTimer = undefined;
	}

	listen() {
		if (this.heartbeatTimer) return Promise.resolve(this);
		return new Promise((resolve, reject) => {
			const onError = (error) => {
				this.server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				this.server.off("error", onError);
				this.heartbeatTimer = setInterval(() => this.#heartbeat(), this.heartbeatMs).unref();
				resolve(this);
			};
			this.server.once("error", onError);
			this.server.once("listening", onListening);
			if (this.socketPath) this.server.listen(this.socketPath);
			else this.server.listen(this.port, this.host);
		});
	}

	close() {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		for (const client of this.clients.values()) client.socket.destroy();
		this.clients.clear();
		return new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	address() {
		return this.server.address();
	}

	getPeers() {
		return [...this.clients.values()].filter((client) => client.authenticated).map((client) => compactPeer(client));
	}

	#log(...args) {
		if (this.verbose) console.error("[pi-bus]", ...args);
	}

	#onConnection(socket) {
		const connectionId = makeId("conn");
		const client = {
			connectionId,
			socket,
			authenticated: false,
			agentId: undefined,
			name: undefined,
			cwd: undefined,
			sessionId: undefined,
			sessionFile: undefined,
			model: undefined,
			pid: undefined,
			rooms: new Set([DEFAULT_ROOM]),
			topics: new Set(["*"]),
			connectedAt: nowIso(),
			lastSeenAt: nowIso(),
			buffer: "",
			write: (record) => {
				if (socket.destroyed || !socket.writable) return false;
				return socket.write(frame(record));
			},
		};
		this.clients.set(connectionId, client);
		this.#log("connection", connectionId, socket.remoteAddress ?? "local");

		socket.setEncoding("utf8");
		socket.on("data", (chunk) => this.#onData(client, chunk));
		socket.on("close", () => this.#onClose(client));
		socket.on("error", (error) => this.#log("socket error", connectionId, error.message));
	}

	#onData(client, chunk) {
		client.buffer += chunk;
		if (Buffer.byteLength(client.buffer, "utf8") > this.maxLineBytes) {
			this.#sendError(client, undefined, `Input line exceeded ${this.maxLineBytes} bytes`, true);
			return;
		}

		while (true) {
			const newlineIndex = client.buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			const line = client.buffer.slice(0, newlineIndex);
			client.buffer = client.buffer.slice(newlineIndex + 1);
			let message;
			try {
				message = parseJsonLine(line);
			} catch (error) {
				this.#sendError(client, undefined, `Invalid JSON: ${error.message}`);
				continue;
			}
			if (message !== undefined) this.#handleMessage(client, message);
		}
	}

	#handleMessage(client, message) {
		if (!isPlainObject(message) || typeof message.type !== "string") {
			this.#sendError(client, message?.id, "Message must be an object with a string type");
			return;
		}
		client.lastSeenAt = nowIso();

		switch (message.type) {
			case "hello":
				this.#handleHello(client, message);
				break;
			case "publish":
				this.#requireAuth(client, message, () => this.#handlePublish(client, message));
				break;
			case "subscribe":
				this.#requireAuth(client, message, () => this.#handleSubscribe(client, message));
				break;
			case "history":
				this.#requireAuth(client, message, () => this.#handleHistory(client, message));
				break;
			case "peers":
				this.#requireAuth(client, message, () => this.#handlePeers(client, message));
				break;
			case "ping":
				client.write({ type: "pong", id: message.id, now: nowIso() });
				break;
			case "pong":
				break;
			default:
				this.#sendError(client, message.id, `Unknown message type: ${message.type}`);
		}
	}

	#requireAuth(client, message, fn) {
		if (!client.authenticated) {
			this.#sendError(client, message.id, "Client must send hello before using the bus");
			return;
		}
		fn();
	}

	#handleHello(client, message) {
		if (message.protocol && message.protocol !== PROTOCOL_VERSION) {
			this.#sendError(client, message.id, `Unsupported protocol ${message.protocol}; expected ${PROTOCOL_VERSION}`, true);
			return;
		}
		if (this.token && message.token !== this.token) {
			this.#sendError(client, message.id, "Invalid PiBus token", true);
			return;
		}

		const agent = isPlainObject(message.agent) ? message.agent : {};
		client.agentId = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : makeId("agent");
		client.name = typeof agent.name === "string" && agent.name.trim() ? agent.name.trim() : client.agentId;
		client.cwd = typeof agent.cwd === "string" ? agent.cwd : undefined;
		client.sessionId = typeof agent.sessionId === "string" ? agent.sessionId : undefined;
		client.sessionFile = typeof agent.sessionFile === "string" ? agent.sessionFile : undefined;
		client.model = typeof agent.model === "string" ? agent.model : undefined;
		client.pid = Number.isFinite(agent.pid) ? agent.pid : undefined;
		client.rooms = new Set(normalizeRooms(message.rooms));
		client.topics = new Set(normalizeTopics(message.topics));
		client.authenticated = true;
		client.lastSeenAt = nowIso();

		client.write({
			type: "welcome",
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

	#handlePublish(client, message) {
		const source = isPlainObject(message.event) ? message.event : message;
		const topic = typeof source.topic === "string" && source.topic.trim() ? source.topic.trim() : DEFAULT_TOPIC;
		const room = typeof source.room === "string" && source.room.trim() ? source.room.trim() : [...client.rooms][0] ?? DEFAULT_ROOM;
		if (!client.rooms.has("*") && !client.rooms.has(room)) {
			this.#sendError(client, message.id, `Client is not joined to room: ${room}`);
			return;
		}
		const target = normalizeTarget(source.target);
		const event = {
			id: typeof source.id === "string" && source.id.trim() ? source.id.trim() : makeId("evt"),
			room,
			topic,
			from: {
				connectionId: client.connectionId,
				agentId: client.agentId,
				name: client.name,
			},
			target,
			text: typeof source.text === "string" ? source.text : undefined,
			payload: source.payload,
			priority: typeof source.priority === "string" ? source.priority : "normal",
			createdAt: nowIso(),
			causeId: typeof source.causeId === "string" ? source.causeId : undefined,
			meta: isPlainObject(source.meta) ? source.meta : undefined,
		};
		if (!event.text) event.text = messageTextFromEvent(event);

		this.#storeHistory(event);
		const recipients = this.#deliverEvent(event, {
			sourceClient: client,
			includeSelf: Boolean(message.includeSelf ?? source.includeSelf),
		});
		client.write({ type: "ack", id: message.id, command: "publish", eventId: event.id, recipients });
		this.emit("event", event);
		this.#log("publish", event.id, event.room, event.topic, "recipients", recipients);
	}

	#handleSubscribe(client, message) {
		if (message.rooms !== undefined) client.rooms = new Set(normalizeRooms(message.rooms));
		if (message.topics !== undefined) client.topics = new Set(normalizeTopics(message.topics));
		client.write({
			type: "ack",
			id: message.id,
			command: "subscribe",
			rooms: [...client.rooms],
			topics: [...client.topics],
		});
		this.#broadcastPresence("update", client);
	}

	#handleHistory(client, message) {
		let events = this.history;
		const requestedRoom = typeof message.room === "string" && message.room.trim() ? message.room.trim() : undefined;
		if (requestedRoom && !client.rooms.has("*") && !client.rooms.has(requestedRoom)) {
			this.#sendError(client, message.id, `Client is not joined to room: ${requestedRoom}`);
			return;
		}
		if (requestedRoom) events = events.filter((event) => event.room === requestedRoom);
		else if (!client.rooms.has("*")) events = events.filter((event) => client.rooms.has(event.room));
		if (typeof message.topic === "string" && message.topic.trim()) events = events.filter((event) => matchTopic(message.topic, event.topic));
		if (typeof message.since === "string" && message.since.trim()) {
			const since = Date.parse(message.since);
			if (!Number.isNaN(since)) events = events.filter((event) => Date.parse(event.createdAt) > since);
		}
		const limit = Math.max(1, Math.min(Number(message.limit ?? 50), this.historyLimit));
		client.write({ type: "history", id: message.id, events: events.slice(-limit) });
	}

	#handlePeers(client, message) {
		client.write({ type: "peers", id: message.id, peers: this.getPeers() });
	}

	#storeHistory(event) {
		this.history.push(event);
		if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
	}

	#deliverEvent(event, { sourceClient, includeSelf }) {
		let recipients = 0;
		for (const client of this.clients.values()) {
			if (!client.authenticated) continue;
			if (!includeSelf && sourceClient && client.connectionId === sourceClient.connectionId) continue;
			if (!this.#clientWantsEvent(client, event)) continue;
			client.write({ type: "event", event });
			recipients++;
		}
		return recipients;
	}

	#clientWantsEvent(client, event) {
		const target = normalizeTarget(event.target);
		if (target.length > 0) {
			return target.includes(client.agentId) || target.includes(client.name) || target.includes(client.connectionId);
		}
		if (!client.rooms.has("*") && !client.rooms.has(event.room)) return false;
		for (const topic of client.topics) if (matchTopic(topic, event.topic)) return true;
		return false;
	}

	#broadcastPresence(action, client) {
		if (!client.authenticated) return;
		const record = { type: "presence", action, peer: compactPeer(client), now: nowIso() };
		for (const other of this.clients.values()) {
			if (!other.authenticated || other.connectionId === client.connectionId) continue;
			other.write(record);
		}
		this.emit("presence", record);
	}

	#onClose(client) {
		this.clients.delete(client.connectionId);
		if (client.authenticated) this.#broadcastPresence("leave", client);
		this.#log("disconnect", client.connectionId, client.agentId ?? "unknown");
	}

	#sendError(client, id, error, fatal = false) {
		client.write({ type: "error", id, error, fatal });
		if (fatal) client.socket.destroy();
	}

	#heartbeat() {
		const now = Date.now();
		for (const client of this.clients.values()) {
			if (!client.authenticated) continue;
			const lastSeen = Date.parse(client.lastSeenAt);
			if (Number.isFinite(lastSeen) && now - lastSeen > this.heartbeatMs * 4) {
				client.socket.destroy();
				continue;
			}
			client.write({ type: "ping", now: nowIso() });
		}
	}
}

export async function createAndListen(options = {}) {
	const server = new PiBusServer(options);
	await server.listen();
	return server;
}
