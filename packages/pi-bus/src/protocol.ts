import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	AgentIdentitySchema,
	BusEventSchema,
	EventHintsSchema,
	PeerSchema,
	type Ack,
	type AgentIdentity,
	type BusEvent,
	type Error as PiBusError,
	type EventHints,
	type HistoryRequest,
	type HistoryResponse,
	type Peer,
	type PeerRef,
	type PeersResponse,
	type Presence,
	type Publish,
	type Subscribe,
	type Welcome,
} from "./gen/pi_bus/v1/pi_bus_pb.ts";

export const PROTOCOL_VERSION = "pi-bus/1" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7373;
export const DEFAULT_ROOM = "default";
export const DEFAULT_TOPIC = "agent.message";

export type {
	Ack,
	AgentIdentity,
	BusEvent,
	EventHints,
	HistoryRequest,
	HistoryResponse,
	Peer,
	PeerRef,
	PeersResponse,
	PiBusError,
	Presence,
	Publish,
	Subscribe,
	Welcome,
};

export type AgentDescriptor = AgentIdentity;
export type PeerDescriptor = Peer;
export type BusEventRecord = BusEvent;
export type BusAck = Ack;
export type BusHistoryResponse = HistoryResponse;
export type BusPeersResponse = PeersResponse;
export type BusPresence = Presence;
export type BusWelcome = Welcome;
export type BusErrorFrame = PiBusError;

export type StringListInput = string | readonly string[] | null | undefined;
export type MetadataInput = Record<string, unknown> | null | undefined;

export interface AgentInput {
	id?: string | null;
	name?: string | null;
	cwd?: string | null;
	sessionId?: string | null;
	sessionFile?: string | null;
	model?: string | null;
	pid?: number | null;
	metadata?: MetadataInput;
}

export interface EventHintsInput {
	push?: boolean | null;
	trigger?: boolean | null;
}

export interface PublishEventInput {
	id?: string | null;
	room?: string | null;
	topic?: string | null;
	from?: PeerRef | null;
	target?: StringListInput;
	text?: string | null;
	payload?: unknown;
	payloadJson?: string | null;
	payload_json?: string | null;
	priority?: string | null;
	createdAt?: string | null;
	created_at?: string | null;
	causeId?: string | null;
	cause_id?: string | null;
	hints?: EventHintsInput | EventHints | null;
	meta?: MetadataInput;
}

export interface PublishOptions {
	includeSelf?: boolean;
	signal?: AbortSignal;
}

export interface SubscribeOptions {
	rooms?: StringListInput;
	topics?: StringListInput;
	signal?: AbortSignal;
}

export interface HistoryFilter {
	room?: string;
	topic?: string;
	since?: string;
	limit?: number;
	signal?: AbortSignal;
}

export interface CommandOptions {
	signal?: AbortSignal;
}

export interface PeerProjectionInput {
	connectionId: string;
	agentId?: string;
	name?: string;
	rooms: Iterable<string>;
	topics: Iterable<string>;
	cwd?: string;
	sessionId?: string;
	sessionFile?: string;
	model?: string;
	pid?: number;
	connectedAt: string;
	lastSeenAt: string;
}

export interface NormalizeBusEventOptions {
	defaultRoom?: string;
	defaultTopic?: string;
	from?: PeerRef;
	createdAt?: string;
}

export function makeId(prefix = "id"): string {
	return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function asArray(value: StringListInput): string[] {
	if (Array.isArray(value)) return [...value];
	if (value === undefined || value === null || value === "") return [];
	return typeof value === "string" ? [value] : [...value];
}

export function splitCsv(value: StringListInput, fallback: readonly string[] = []): string[] {
	if (Array.isArray(value)) {
		const result = value.flatMap((item) => splitCsv(item, []));
		return result.length > 0 ? result : [...fallback];
	}
	if (value === undefined || value === null) return [...fallback];
	const result = String(value)
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	return result.length > 0 ? result : [...fallback];
}

export function normalizeRooms(value: StringListInput): string[] {
	return splitCsv(value, [DEFAULT_ROOM]);
}

export function normalizeTopics(value: StringListInput): string[] {
	return splitCsv(value, ["*"]);
}

export function normalizeTarget(value: StringListInput): string[] {
	return splitCsv(value, []);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return JSON.stringify({ error: `Failed to serialize value: ${message}` });
	}
}

export function matchTopic(pattern: string, topic: string): boolean {
	if (!pattern || pattern === "*") return true;
	if (pattern === topic) return true;
	if (pattern.endsWith(".*")) return topic === pattern.slice(0, -2) || topic.startsWith(pattern.slice(0, -1));
	if (pattern.endsWith("*")) return topic.startsWith(pattern.slice(0, -1));
	return false;
}

export function messageTextFromEvent(event: {
	text?: unknown;
	payloadJson?: unknown;
	payload_json?: unknown;
	payload?: unknown;
}): string {
	if (typeof event.text === "string" && event.text.length > 0) return event.text;
	if (typeof event.payloadJson === "string" && event.payloadJson.length > 0) return event.payloadJson;
	if (typeof event.payload_json === "string" && event.payload_json.length > 0) return event.payload_json;
	if (typeof event.payload === "string") return event.payload;
	if (event.payload !== undefined) return safeJsonStringify(event.payload);
	return "";
}

export function normalizeMeta(value: MetadataInput): Record<string, string> {
	if (!isPlainObject(value)) return {};
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined || item === null) continue;
		result[key] = typeof item === "string" ? item : safeJsonStringify(item);
	}
	return result;
}

export function metaBool(meta: Record<string, unknown> | undefined, key: string): boolean {
	const value = meta?.[key];
	return value === true || value === "true" || value === "1" || value === "yes" || value === "on";
}

export function metaBoolValue(value: unknown): boolean | undefined {
	if (value === true || value === "true" || value === "1" || value === "yes" || value === "on") return true;
	if (value === false || value === "false" || value === "0" || value === "no" || value === "off") return false;
	return undefined;
}

export function sanitizeAgent(agent: unknown = {}): AgentIdentity {
	const source = isPlainObject(agent) ? agent : {};
	const id = stringOrUndefined(source.id)?.trim() || makeId("agent");
	const name = stringOrUndefined(source.name)?.trim() || id;
	return create(AgentIdentitySchema, {
		id,
		name,
		cwd: stringOrUndefined(source.cwd) ?? "",
		sessionId: stringOrUndefined(source.sessionId) ?? "",
		sessionFile: stringOrUndefined(source.sessionFile) ?? "",
		model: stringOrUndefined(source.model) ?? "",
		pid: uint32OrZero(source.pid),
		metadata: normalizeMeta(source.metadata as MetadataInput),
	});
}

export function compactPeer(peer: PeerProjectionInput): Peer {
	return create(PeerSchema, {
		connectionId: peer.connectionId,
		agentId: peer.agentId ?? "",
		name: peer.name ?? peer.agentId ?? peer.connectionId,
		rooms: [...peer.rooms],
		topics: [...peer.topics],
		cwd: peer.cwd ?? "",
		sessionId: peer.sessionId ?? "",
		sessionFile: peer.sessionFile ?? "",
		model: peer.model ?? "",
		pid: uint32OrZero(peer.pid),
		connectedAt: peer.connectedAt,
		lastSeenAt: peer.lastSeenAt,
	});
}

export function normalizeHints(value: EventHintsInput | EventHints | null | undefined): EventHints | undefined {
	if (!isPlainObject(value)) return undefined;
	const push = booleanOrUndefined(value.push);
	const trigger = booleanOrUndefined(value.trigger);
	if (push === undefined && trigger === undefined) return undefined;
	return create(EventHintsSchema, {
		...(push === undefined ? {} : { push }),
		...(trigger === undefined ? {} : { trigger }),
	});
}

export function normalizeBusEvent(input: PublishEventInput | BusEvent | undefined, options: NormalizeBusEventOptions = {}): BusEvent {
	const source = isPlainObject(input) ? (input as PublishEventInput & Partial<BusEvent>) : {};
	const explicitText = typeof source.text === "string";
	const payloadJson = stringOrUndefined(source.payloadJson) ?? stringOrUndefined(source.payload_json) ?? (source.payload === undefined ? "" : safeJsonStringify(source.payload));
	const createdAt = stringOrUndefined(source.createdAt) ?? stringOrUndefined(source.created_at) ?? options.createdAt ?? nowIso();
	const causeId = stringOrUndefined(source.causeId) ?? stringOrUndefined(source.cause_id) ?? "";
	const hints = normalizeHints(source.hints);
	const event = create(BusEventSchema, {
		id: stringOrUndefined(source.id)?.trim() || makeId("evt"),
		room: stringOrUndefined(source.room)?.trim() || options.defaultRoom || DEFAULT_ROOM,
		topic: stringOrUndefined(source.topic)?.trim() || options.defaultTopic || DEFAULT_TOPIC,
		...(options.from ? { from: options.from } : source.from ? { from: source.from } : {}),
		target: normalizeTarget(source.target),
		text: explicitText ? source.text ?? "" : "",
		payloadJson,
		priority: stringOrUndefined(source.priority) || "normal",
		createdAt,
		causeId,
		...(hints ? { hints } : {}),
		meta: normalizeMeta(source.meta as MetadataInput),
	});
	if (!explicitText) event.text = messageTextFromEvent(event);
	return event;
}

export function finiteNumber(value: unknown, fallback: number, name: string): number {
	const numberValue = value === undefined || value === null || value === "" ? fallback : Number(value);
	if (!Number.isFinite(numberValue)) throw new TypeError(`${name} must be a finite number`);
	return numberValue;
}

export function positiveInteger(value: unknown, fallback: number, name: string): number {
	const numberValue = finiteNumber(value, fallback, name);
	if (!Number.isInteger(numberValue) || numberValue <= 0) throw new TypeError(`${name} must be a positive integer`);
	return numberValue;
}

export function portNumber(value: unknown, fallback = DEFAULT_PORT, name = "port", allowZero = false): number {
	const numberValue = finiteNumber(value, fallback, name);
	const min = allowZero ? 0 : 1;
	if (!Number.isInteger(numberValue) || numberValue < min || numberValue > 65_535) {
		throw new TypeError(`${name} must be between ${min} and 65535`);
	}
	return numberValue;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	return metaBoolValue(value);
}

function uint32OrZero(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return Math.min(0xffff_ffff, Math.trunc(value));
}
