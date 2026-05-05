import { randomBytes } from "node:crypto";

export const PROTOCOL_VERSION = "pi-bus/1";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7373;
export const DEFAULT_ROOM = "default";
export const DEFAULT_TOPIC = "agent.message";

export function makeId(prefix = "id") {
	return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

export function nowIso() {
	return new Date().toISOString();
}

export function asArray(value) {
	if (Array.isArray(value)) return value;
	if (value === undefined || value === null || value === "") return [];
	return [value];
}

export function splitCsv(value, fallback = []) {
	if (Array.isArray(value)) {
		const result = value.flatMap((item) => splitCsv(item, []));
		return result.length > 0 ? result : fallback;
	}
	if (value === undefined || value === null) return fallback;
	const result = String(value)
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	return result.length > 0 ? result : fallback;
}

export function normalizeRooms(value) {
	return splitCsv(value, [DEFAULT_ROOM]);
}

export function normalizeTopics(value) {
	return splitCsv(value, ["*"]);
}

export function normalizeTarget(value) {
	return splitCsv(value, []);
}

export function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeJsonStringify(value) {
	try {
		return JSON.stringify(value);
	} catch (error) {
		return JSON.stringify({ error: `Failed to serialize value: ${error?.message ?? String(error)}` });
	}
}

export function frame(record) {
	return `${safeJsonStringify(record)}\n`;
}

export function parseJsonLine(line) {
	if (line.endsWith("\r")) line = line.slice(0, -1);
	if (!line.trim()) return undefined;
	return JSON.parse(line);
}

export function matchTopic(pattern, topic) {
	if (!pattern || pattern === "*") return true;
	if (pattern === topic) return true;
	if (pattern.endsWith(".*")) return topic === pattern.slice(0, -2) || topic.startsWith(pattern.slice(0, -1));
	if (pattern.endsWith("*")) return topic.startsWith(pattern.slice(0, -1));
	return false;
}

export function messageTextFromEvent(event) {
	if (typeof event.text === "string" && event.text.length > 0) return event.text;
	if (typeof event.payload === "string") return event.payload;
	if (event.payload !== undefined) return safeJsonStringify(event.payload);
	return "";
}

export function sanitizeAgent(agent: any = {}) {
	const source = (isPlainObject(agent) ? agent : {}) as Record<string, any>;
	const id = typeof source.id === "string" && source.id.trim() ? source.id.trim() : makeId("agent");
	const name = typeof source.name === "string" && source.name.trim() ? source.name.trim() : id;
	return {
		id,
		name,
		cwd: typeof source.cwd === "string" ? source.cwd : undefined,
		sessionId: typeof source.sessionId === "string" ? source.sessionId : undefined,
		sessionFile: typeof source.sessionFile === "string" ? source.sessionFile : undefined,
		model: typeof source.model === "string" ? source.model : undefined,
		pid: Number.isFinite(source.pid) ? source.pid : undefined,
		metadata: isPlainObject(source.metadata) ? source.metadata : undefined,
	};
}

export function compactPeer(peer: any) {
	return {
		connectionId: peer.connectionId,
		agentId: peer.agentId,
		name: peer.name,
		rooms: [...peer.rooms],
		topics: [...peer.topics],
		cwd: peer.cwd,
		sessionId: peer.sessionId,
		sessionFile: peer.sessionFile,
		model: peer.model,
		pid: peer.pid,
		connectedAt: peer.connectedAt,
		lastSeenAt: peer.lastSeenAt,
	};
}
