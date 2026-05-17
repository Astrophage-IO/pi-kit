import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { PiBusClient, type PiBusClientErrorEvent, type ReconnectingEvent } from "../src/client.ts";
import {
	DEFAULT_HOST,
	DEFAULT_PORT,
	DEFAULT_ROOM,
	DEFAULT_TOPIC,
	messageTextFromEvent,
	metaBoolValue,
	splitCsv,
	type BusEvent,
	type Peer,
	type Presence,
	type Welcome,
} from "../src/protocol.ts";

const MAX_INBOX = 200;
const DEFAULT_TOPICS = "*";
const DEFAULT_PUSH_MODE = "targeted";
const DEFAULT_TRIGGER_MODE = "targeted";
const PROCESS_AGENT_ID = `${os.hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

type PushMode = "off" | "targeted" | "all";
type TriggerMode = PushMode;

function envBool(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined) return fallback;
	return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function flagString(pi: ExtensionAPI, name: string, fallback: string): string {
	const value = pi.getFlag(name);
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function flagBool(pi: ExtensionAPI, name: string, fallback: boolean): boolean {
	const value = pi.getFlag(name);
	return typeof value === "boolean" ? value : fallback;
}

function normalizePushMode(value: string | undefined, fallback: PushMode = DEFAULT_PUSH_MODE): PushMode {
	if (value === "off" || value === "targeted" || value === "all") return value;
	return fallback;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function eventText(event: BusEvent): string {
	return messageTextFromEvent(event) || "(no message text)";
}

function fromLabel(event: BusEvent): string {
	return event.from?.name || event.from?.agentId || event.from?.connectionId || "unknown";
}

function formatEventForLlm(event: BusEvent): string {
	const target = event.target && event.target.length > 0 ? ` -> ${event.target.join(", ")}` : "";
	return [
		`PiBus event ${event.id} on ${event.room}/${event.topic} from ${fromLabel(event)}${target}:`,
		eventText(event),
	].join("\n");
}

function formatEventList(events: BusEvent[], unread?: Set<string>): string {
	if (events.length === 0) return "No PiBus messages.";
	return events
		.map((event) => {
			const when = event.createdAt ?? "unknown time";
			const target = event.target && event.target.length > 0 ? ` -> ${event.target.join(",")}` : "";
			const marker = unread?.has(event.id) ? "*" : " ";
			const cause = event.causeId ? ` (reply to ${event.causeId})` : "";
			return `-${marker} [${when}] ${event.room}/${event.topic} ${fromLabel(event)}${target}${cause}: ${eventText(event)}`;
		})
		.join("\n");
}

function isAddressedTo(event: BusEvent, agentId: string, agentName: string, connectionId?: string): boolean {
	const target = event.target ?? [];
	return target.includes(agentId) || target.includes(agentName) || Boolean(connectionId && target.includes(connectionId));
}

export interface ParsedBusSendArgs {
	topic?: string;
	room?: string;
	target?: string;
	replyTo?: string;
	text: string;
}

export function parseBusSendArgs(args: string): ParsedBusSendArgs {
	const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
	const result: ParsedBusSendArgs = { text: "" };
	const remaining: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const isOpt = token.startsWith("--");
		const next = tokens[i + 1];
		const takeNext = (): string | undefined => {
			if (next === undefined || next.startsWith("--")) return undefined;
			i++;
			return stripQuotes(next);
		};
		if (isOpt && (token === "--topic" || token === "--room" || token === "--target" || token === "--reply-to" || token === "--replyTo")) {
			const value = takeNext();
			if (value === undefined) continue;
			if (token === "--topic") result.topic = value;
			else if (token === "--room") result.room = value;
			else if (token === "--target") result.target = value;
			else result.replyTo = value;
		} else if (isOpt && (token.startsWith("--topic=") || token.startsWith("--room=") || token.startsWith("--target=") || token.startsWith("--reply-to=") || token.startsWith("--replyTo="))) {
			const equalIndex = token.indexOf("=");
			const key = token.slice(0, equalIndex);
			const value = stripQuotes(token.slice(equalIndex + 1));
			if (key === "--topic") result.topic = value;
			else if (key === "--room") result.room = value;
			else if (key === "--target") result.target = value;
			else result.replyTo = value;
		} else {
			remaining.push(stripQuotes(token));
		}
	}
	result.text = remaining.join(" ").trim();
	return result;
}

function stripQuotes(value: string): string {
	if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) return value.slice(1, -1);
	return value;
}

function eventMatches(
	event: BusEvent,
	filter: { room?: string; topic?: string; from?: string; target?: string },
	agentId: string,
	agentName: string,
	connectionId?: string,
): boolean {
	if (filter.room && event.room !== filter.room) return false;
	if (filter.topic && event.topic !== filter.topic) return false;
	if (filter.from) {
		const from = event.from;
		if (from?.agentId !== filter.from && from?.name !== filter.from && from?.connectionId !== filter.from) return false;
	}
	if (filter.target === "me" && !isAddressedTo(event, agentId, agentName, connectionId)) return false;
	if (filter.target && filter.target !== "me" && !(event.target ?? []).includes(filter.target)) return false;
	return true;
}

export default function piBusExtension(pi: ExtensionAPI) {
	pi.registerFlag("bus-host", {
		description: "PiBus broker host",
		type: "string",
		default: process.env.PIBUS_HOST ?? DEFAULT_HOST,
	});
	pi.registerFlag("bus-port", {
		description: "PiBus broker port",
		type: "string",
		default: process.env.PIBUS_PORT ?? String(DEFAULT_PORT),
	});
	pi.registerFlag("bus-socket", {
		description: "PiBus Unix socket path. Overrides host/port when set.",
		type: "string",
		default: process.env.PIBUS_SOCKET ?? "",
	});
	pi.registerFlag("bus-token", {
		description: "PiBus shared token",
		type: "string",
		default: process.env.PIBUS_TOKEN ?? "",
	});
	pi.registerFlag("bus-room", {
		description: "Comma-separated PiBus rooms to join",
		type: "string",
		default: process.env.PIBUS_ROOM ?? DEFAULT_ROOM,
	});
	pi.registerFlag("bus-topics", {
		description: "Comma-separated PiBus topics to subscribe to. Supports '*' and 'prefix.*'.",
		type: "string",
		default: process.env.PIBUS_TOPICS ?? DEFAULT_TOPICS,
	});
	pi.registerFlag("bus-agent", {
		description: "Stable PiBus agent id for this pi process",
		type: "string",
		default: process.env.PIBUS_AGENT ?? PROCESS_AGENT_ID,
	});
	pi.registerFlag("bus-name", {
		description: "Human-readable PiBus agent name",
		type: "string",
		default: process.env.PIBUS_NAME ?? "",
	});
	pi.registerFlag("bus-autostart", {
		description: "Connect to PiBus on session start",
		type: "boolean",
		default: envBool("PIBUS_AUTOSTART", true),
	});
	pi.registerFlag("bus-push", {
		description: "Push incoming events into the agent automatically: off, targeted, or all",
		type: "string",
		default: process.env.PIBUS_PUSH ?? process.env.PIBUS_PUSH_MODE ?? DEFAULT_PUSH_MODE,
	});
	pi.registerFlag("bus-trigger", {
		description: "Trigger an agent turn for pushed events: off, targeted, or all",
		type: "string",
		default: process.env.PIBUS_TRIGGER ?? process.env.PIBUS_TRIGGER_MODE ?? DEFAULT_TRIGGER_MODE,
	});

	let client: PiBusClient | undefined;
	let currentCtx: ExtensionContext | undefined;
	let connectPromise: Promise<void> | undefined;
	let inbox: BusEvent[] = [];
	let unread = new Set<string>();
	let peers: Peer[] = [];
	let config = {
		agentId: PROCESS_AGENT_ID,
		agentName: PROCESS_AGENT_ID,
		rooms: [DEFAULT_ROOM],
		topics: ["*"],
		pushMode: DEFAULT_PUSH_MODE as PushMode,
		triggerMode: DEFAULT_TRIGGER_MODE as TriggerMode,
	};

	function readConfig(ctx: ExtensionContext) {
		const cwdName = path.basename(ctx.cwd) || "pi";
		const agentId = flagString(pi, "bus-agent", PROCESS_AGENT_ID);
		const agentName = flagString(pi, "bus-name", `${cwdName}:${process.pid}`) || `${cwdName}:${process.pid}`;
		config = {
			agentId,
			agentName,
			rooms: splitCsv(flagString(pi, "bus-room", DEFAULT_ROOM), [DEFAULT_ROOM]),
			topics: splitCsv(flagString(pi, "bus-topics", DEFAULT_TOPICS), ["*"]),
			pushMode: normalizePushMode(flagString(pi, "bus-push", DEFAULT_PUSH_MODE), DEFAULT_PUSH_MODE),
			triggerMode: normalizePushMode(flagString(pi, "bus-trigger", DEFAULT_TRIGGER_MODE), DEFAULT_TRIGGER_MODE) as TriggerMode,
		};
		return config;
	}

	function updateStatus(text: string | undefined) {
		currentCtx?.ui.setStatus("pi-bus", text ? `bus: ${text}` : undefined);
	}

	function remember(event: BusEvent) {
		inbox.push(event);
		unread.add(event.id);
		while (inbox.length > MAX_INBOX) {
			const removed = inbox.shift();
			if (removed) unread.delete(removed.id);
		}
	}

	function handleIncoming(event: BusEvent) {
		if (!event || event.from?.agentId === config.agentId) return;
		remember(event);
		const addressed = isAddressedTo(event, config.agentId, config.agentName, client?.connectionId);
		const pushHint = event.hints?.push ?? metaBoolValue(event.meta?.push);
		const triggerHint = event.hints?.trigger ?? metaBoolValue(event.meta?.trigger);
		const pushRequested = pushHint === true || triggerHint === true;
		const pushSuppressed = pushHint === false;
		const shouldPush = !pushSuppressed && (pushRequested || config.pushMode === "all" || (config.pushMode === "targeted" && addressed));
		const shouldTrigger = shouldPush && (triggerHint === true || config.triggerMode === "all" || (config.triggerMode === "targeted" && addressed));
		if (currentCtx?.hasUI) {
			const kind = shouldPush ? "pushed" : "buffered";
			if (addressed || shouldPush) currentCtx.ui.notify(`PiBus ${kind} from ${fromLabel(event)}: ${eventText(event).slice(0, 120)}`, "info");
		}
		if (!shouldPush) return;
		try {
			pi.sendMessage(
				{
					customType: "pi-bus.event",
					content: formatEventForLlm(event),
					display: true,
					details: event,
				},
				{ triggerTurn: shouldTrigger },
			);
		} catch (error) {
			currentCtx?.ui.notify(`PiBus failed to inject message: ${(error as Error).message}`, "error");
		}
	}

	async function connect(ctx: ExtensionContext) {
		currentCtx = ctx;
		readConfig(ctx);
		if (client?.isOnline) return;
		if (connectPromise) return connectPromise;

		const host = flagString(pi, "bus-host", DEFAULT_HOST);
		const port = Number(flagString(pi, "bus-port", String(DEFAULT_PORT)));
		const socketPath = flagString(pi, "bus-socket", "") || undefined;
		const token = flagString(pi, "bus-token", "") || undefined;
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		const sessionId = ctx.sessionManager.getSessionId?.();

		client?.close();
		client = new PiBusClient({
			host,
			port,
			socketPath,
			token,
			agent: {
				id: config.agentId,
				name: config.agentName,
				cwd: ctx.cwd,
				sessionFile,
				sessionId,
				model,
				pid: process.pid,
			},
			rooms: config.rooms,
			topics: config.topics,
			reconnect: true,
		});

		client.on("online", (welcome: Welcome) => {
			peers = welcome.peers;
			updateStatus(`online ${config.rooms.join(",")}`);
			ctx.ui.notify(`PiBus connected as ${config.agentName} (${config.agentId})`, "info");
		});
		client.on("offline", () => updateStatus("offline"));
		client.on("reconnecting", ({ delay }: ReconnectingEvent) => updateStatus(`reconnecting in ${Math.round(delay / 1000)}s`));
		client.on("presence", (message: Presence) => {
			peers = client?.peers ?? peers;
			if (ctx.hasUI && message.action === "join") ctx.ui.notify(`PiBus peer joined: ${message.peer?.name ?? message.peer?.agentId}`, "info");
		});
		client.on("peers", (items: Peer[]) => (peers = items));
		client.on("bus_event", handleIncoming);
		client.on("bus_error", (message: PiBusClientErrorEvent) => ctx.ui.notify(`PiBus error: ${message.error ?? safeJson(message)}`, "error"));

		updateStatus("connecting");
		connectPromise = client
			.connect()
			.then(() => undefined)
			.catch((error: Error) => {
				updateStatus("offline");
				ctx.ui.notify(`PiBus connection failed: ${error.message}`, "warning");
			})
			.finally(() => {
				connectPromise = undefined;
			});
		return connectPromise;
	}

	function disconnect(clearStatus = false) {
		client?.close();
		client = undefined;
		connectPromise = undefined;
		peers = [];
		if (clearStatus) updateStatus(undefined);
		else updateStatus("offline");
	}

	function requireClient() {
		if (!client?.isOnline) throw new Error("PiBus is not connected. Start pi-bus-server or call bus_connect first.");
		return client;
	}

	pi.registerMessageRenderer("pi-bus.event", (message, _options, theme) => {
		const event = message.details as BusEvent | undefined;
		const label = event ? `${event.room}/${event.topic}` : "pi-bus";
		const from = event ? fromLabel(event) : "unknown";
		const text = typeof message.content === "string" ? message.content.split("\n").slice(1).join("\n") : "";
		return new Text(`${theme.fg("accent", "PiBus")} ${theme.fg("muted", label)} ${theme.fg("dim", `from ${from}`)}\n${theme.fg("toolOutput", text)}`, 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		readConfig(ctx);
		if (flagBool(pi, "bus-autostart", true)) await connect(ctx);
	});

	pi.on("session_shutdown", async () => {
		disconnect(true);
	});

	pi.on("before_agent_start", (event, ctx) => {
		readConfig(ctx);
		const status = client?.isOnline ? "connected" : "not connected";
		const busPrompt = [
			"PiBus multi-agent event bus is available for push-based coordination with other isolated pi agents.",
			`PiBus status: ${status}. Your PiBus id/name: ${config.agentId} / ${config.agentName}. Rooms: ${config.rooms.join(", ")}. Subscribed topics: ${config.topics.join(", ")}. Push mode: ${config.pushMode}. Trigger mode: ${config.triggerMode}.`,
			"When connected, incoming PiBus events are pushed into context automatically and can trigger a turn; bus_inbox is only a local buffer for review.",
			"Use bus_connect to join, bus_publish for handoffs/questions/discoveries/blockers/status updates, bus_agents to discover peers, and bus_disconnect when this isolated agent should stop receiving.",
			"Avoid publishing every internal thought. Publish concise, actionable information and include a target when a specific peer should react.",
		].join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${busPrompt}` };
	});

	pi.registerCommand("bus-connect", {
		description: "Connect this isolated pi agent to the PiBus broker and start receiving pushed events",
		handler: async (_args, ctx) => {
			await connect(ctx);
		},
	});

	pi.registerCommand("bus-disconnect", {
		description: "Disconnect this isolated pi agent from PiBus and stop receiving pushed events",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			disconnect(false);
			ctx.ui.notify("PiBus disconnected; this agent will not receive pushed events until /bus-connect.", "info");
		},
	});

	pi.registerCommand("bus-reconnect", {
		description: "Reconnect this pi session to the PiBus broker",
		handler: async (_args, ctx) => {
			disconnect(false);
			await connect(ctx);
		},
	});

	pi.registerCommand("bus-status", {
		description: "Show PiBus connection status and peers",
		handler: async (_args, ctx) => {
			if (client?.isOnline) {
				try {
					const response = await client.requestPeers();
					peers = response.peers ?? peers;
				} catch {
					// keep cached peers
				}
			}
			const text = [
				`PiBus: ${client?.isOnline ? "online" : "offline"}`,
				`Agent: ${config.agentName} (${config.agentId})`,
				`Rooms: ${config.rooms.join(", ")}`,
				`Topics: ${config.topics.join(", ")}`,
				`Push mode: ${config.pushMode}`,
				`Trigger mode: ${config.triggerMode}`,
				`Peers: ${peers.length}`,
				...peers.map((peer) => `  - ${peer.name ?? peer.agentId} (${peer.agentId}) rooms=${peer.rooms?.join(",") ?? ""}`),
			].join("\n");
			ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("bus-send", {
		description: "Publish a PiBus message. Usage: /bus-send [--topic t] [--target peer] [--reply-to id] message",
		handler: async (args, ctx) => {
			await connect(ctx);
			const c = requireClient();
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /bus-send [--topic t] [--target peer] [--reply-to id] message", "warning");
				return;
			}
			const parsed = parseBusSendArgs(trimmed);
			if (!parsed.text) {
				ctx.ui.notify("Usage: /bus-send [--topic t] [--target peer] [--reply-to id] message", "warning");
				return;
			}
			const ack = await c.publish({
				room: parsed.room ?? config.rooms[0] ?? DEFAULT_ROOM,
				topic: parsed.topic ?? DEFAULT_TOPIC,
				text: parsed.text,
				target: parsed.target,
				causeId: parsed.replyTo,
				hints: { push: true },
			});
			ctx.ui.notify(`Published ${ack.eventId} to ${ack.recipients} peer(s)`, "info");
		},
	});

	pi.registerCommand("bus-inbox", {
		description: "Show recent PiBus messages (unread are marked with *)",
		handler: async (_args, ctx) => {
			const recent = inbox.slice(-50);
			const header = `PiBus inbox: ${recent.length} shown, ${unread.size} unread`;
			const body = formatEventList(recent, unread);
			const text = `${header}\n${body}`;
			if (ctx.hasUI) await ctx.ui.editor("PiBus inbox", text);
			else ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("bus-history", {
		description: "Fetch recent PiBus events from the broker. Usage: /bus-history [room] [topic]",
		handler: async (args, ctx) => {
			await connect(ctx);
			const c = requireClient();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const room = parts[0];
			const topic = parts[1];
			const response = await c.requestHistory({ room, topic, limit: 50 });
			const text = `PiBus history${room ? ` (room=${room})` : ""}${topic ? ` (topic=${topic})` : ""}: ${response.events.length} event(s)\n${formatEventList(response.events)}`;
			if (ctx.hasUI) await ctx.ui.editor("PiBus history", text);
			else ctx.ui.notify(text, "info");
		},
	});

	pi.registerTool({
		name: "bus_connect",
		label: "PiBus Connect",
		description: "Connect this isolated pi agent to the PiBus broker. Once connected, matching incoming events are pushed into context automatically.",
		promptSnippet: "Connect this isolated pi agent to PiBus so it can send and receive pushed events",
		promptGuidelines: [
			"Use bus_connect when PiBus is disconnected and the task requires coordination with other pi agents.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			await connect(ctx);
			const c = requireClient();
			return {
				content: [{ type: "text", text: `Connected to PiBus as ${config.agentName} (${config.agentId}); pushed events are enabled in ${config.pushMode} mode and trigger mode is ${config.triggerMode}.` }],
				details: { agentId: config.agentId, agentName: config.agentName, rooms: config.rooms, topics: config.topics, pushMode: config.pushMode, triggerMode: config.triggerMode, connectionId: c.connectionId },
			};
		},
	});

	pi.registerTool({
		name: "bus_disconnect",
		label: "PiBus Disconnect",
		description: "Disconnect this isolated pi agent from PiBus. It can no longer receive pushed events until bus_connect is called again.",
		promptSnippet: "Disconnect this isolated pi agent from PiBus and stop receiving pushed events",
		parameters: Type.Object({}),
		async execute() {
			disconnect(false);
			return {
				content: [{ type: "text", text: "Disconnected from PiBus. This agent will not receive pushed events until bus_connect is called." }],
				details: { disconnected: true },
			};
		},
	});

	pi.registerTool({
		name: "bus_publish",
		label: "PiBus Publish",
		description: "Publish a concise message to other pi agents over PiBus. Use for handoffs, questions, discoveries, blockers, and status updates.",
		promptSnippet: "Publish a message to other pi agents on the shared PiBus event bus",
		promptGuidelines: [
			"Use bus_publish when coordination with another pi agent would help, especially for handoffs, status updates, direct questions, and sharing findings.",
			"Keep bus_publish messages concise and actionable; include target when a specific peer should react.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "Message text to publish. Keep it concise and actionable." }),
			topic: Type.Optional(Type.String({ description: `Topic to publish on. Default: ${DEFAULT_TOPIC}` })),
			room: Type.Optional(Type.String({ description: "Room to publish to. Defaults to this agent's first room." })),
			target: Type.Optional(Type.String({ description: "Optional comma-separated target agent ids/names for a direct message." })),
			priority: Type.Optional(Type.String({ description: "Optional priority, e.g. low, normal, high." })),
			push: Type.Optional(Type.Boolean({ description: "Hint recipients to push this event into context immediately. Default: true." })),
			trigger: Type.Optional(Type.Boolean({ description: "Hint recipients to trigger an agent turn immediately. Default: false unless addressed and recipient trigger mode is targeted." })),
			includeSelf: Type.Optional(Type.Boolean({ description: "Whether this agent should receive its own event." })),
			replyTo: Type.Optional(Type.String({ description: "PiBus event id this message is replying to. Sets causeId so recipients can thread the conversation." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await connect(ctx);
			const c = requireClient();
			const ack = await c.publish(
				{
					room: params.room ?? config.rooms[0] ?? DEFAULT_ROOM,
					topic: params.topic ?? DEFAULT_TOPIC,
					text: params.text,
					target: params.target,
					priority: params.priority ?? "normal",
					hints: { push: params.push ?? true, trigger: params.trigger ?? false },
					causeId: params.replyTo,
				},
				{ includeSelf: params.includeSelf ?? false },
			);
			return {
				content: [{ type: "text", text: `Published PiBus event ${ack.eventId} to ${ack.recipients} peer(s).` }],
				details: ack,
			};
		},
	});

	pi.registerTool({
		name: "bus_history",
		label: "PiBus History",
		description: "Fetch recent PiBus events from the broker's retained history. Useful after reconnecting to catch up on events received while this agent was offline.",
		promptSnippet: "Fetch recent PiBus events from the broker history",
		promptGuidelines: [
			"Use bus_history to catch up after reconnecting or to inspect events that arrived before this agent joined the room.",
			"Prefer bus_inbox for events already received by this agent; use bus_history when you suspect there were earlier events you missed.",
		],
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Maximum number of events to return. Default: 25." })),
			topic: Type.Optional(Type.String({ description: "Topic filter; supports wildcards like agent.* (broker-side)." })),
			room: Type.Optional(Type.String({ description: "Room to fetch history from. Defaults to this agent's first room." })),
			since: Type.Optional(Type.String({ description: "ISO timestamp; only return events created after this moment." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await connect(ctx);
			const c = requireClient();
			const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
			const room = params.room ?? config.rooms[0] ?? DEFAULT_ROOM;
			const response = await c.requestHistory({ room, topic: params.topic, since: params.since, limit });
			return {
				content: [{ type: "text", text: formatEventList(response.events) }],
				details: { events: response.events, room, topic: params.topic, since: params.since, limit },
			};
		},
	});

	pi.registerTool({
		name: "bus_inbox",
		label: "PiBus Inbox",
		description: "Read recent PiBus messages received by this agent.",
		promptSnippet: "Read recent messages received from other pi agents over PiBus",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Maximum number of messages to return. Default: 20." })),
			topic: Type.Optional(Type.String({ description: "Only return messages on this topic." })),
			room: Type.Optional(Type.String({ description: "Only return messages in this room." })),
			unreadOnly: Type.Optional(Type.Boolean({ description: "Only return unread messages. Default: false." })),
			markRead: Type.Optional(Type.Boolean({ description: "Mark returned messages as read. Default: true." })),
		}),
		async execute(_toolCallId, params) {
			const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
			let events = inbox.filter((event) => eventMatches(event, { room: params.room, topic: params.topic }, config.agentId, config.agentName, client?.connectionId));
			if (params.unreadOnly) events = events.filter((event) => unread.has(event.id));
			events = events.slice(-limit);
			const unreadSnapshot = new Set(unread);
			if (params.markRead ?? true) for (const event of events) unread.delete(event.id);
			const header = `PiBus inbox: ${events.length} shown, ${unread.size} unread`;
			return {
				content: [{ type: "text", text: `${header}\n${formatEventList(events, unreadSnapshot)}` }],
				details: { events, unreadCount: unread.size },
			};
		},
	});

	pi.registerTool({
		name: "bus_agents",
		label: "PiBus Agents",
		description: "List pi agents currently connected to PiBus.",
		promptSnippet: "List other pi agents connected to PiBus",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			await connect(ctx);
			if (client?.isOnline) {
				const response = await client.requestPeers();
				peers = response.peers ?? [];
			}
			const others = peers.filter((peer) => peer.agentId !== config.agentId);
			const text = others.length === 0
				? "No other PiBus agents are currently connected."
				: others.map((peer) => `- ${peer.name ?? peer.agentId} (${peer.agentId}) rooms=${peer.rooms?.join(",") ?? ""} topics=${peer.topics?.join(",") ?? ""}`).join("\n");
			return { content: [{ type: "text", text }], details: { peers: others } };
		},
	});

	pi.registerTool({
		name: "bus_wait",
		label: "PiBus Wait",
		description: "Wait briefly for PiBus messages matching optional filters. Useful after asking another agent a direct question.",
		parameters: Type.Object({
			topic: Type.Optional(Type.String({ description: "Only wait for this topic." })),
			room: Type.Optional(Type.String({ description: "Only wait in this room." })),
			from: Type.Optional(Type.String({ description: "Only wait for messages from this agent id/name." })),
			target: Type.Optional(Type.String({ description: "Only wait for messages targeting this id/name, or 'me'." })),
			count: Type.Optional(Type.Number({ description: "Number of messages to wait for. Default: 1." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait in milliseconds. Default: 30000, max: 120000." })),
			includeBuffered: Type.Optional(Type.Boolean({ description: "Include already buffered matching messages before waiting. Default: true." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await connect(ctx);
			const c = requireClient();
			const count = Math.max(1, Math.min(params.count ?? 1, 20));
			const timeoutMs = Math.max(100, Math.min(params.timeoutMs ?? 30_000, 120_000));
			const filter = { room: params.room, topic: params.topic, from: params.from, target: params.target };
			const collected: BusEvent[] = [];
			const maybeAdd = (event: BusEvent) => {
				if (!eventMatches(event, filter, config.agentId, config.agentName, c.connectionId)) return;
				if (collected.some((item) => item.id === event.id)) return;
				collected.push(event);
			};
			if (params.includeBuffered ?? true) {
				for (const event of inbox) maybeAdd(event);
				if (collected.length >= count) {
					const events = collected.slice(0, count);
					return { content: [{ type: "text", text: formatEventList(events) }], details: { events, timedOut: false } };
				}
			}
			await new Promise<void>((resolve) => {
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					clearTimeout(timeout);
					c.off("bus_event", handler);
					signal?.removeEventListener("abort", finish);
					resolve();
				};
				const handler = (event: BusEvent) => {
					maybeAdd(event);
					if (collected.length >= count) finish();
				};
				const timeout = setTimeout(finish, timeoutMs);
				timeout.unref?.();
				c.on("bus_event", handler);
				if (signal?.aborted) finish();
				else signal?.addEventListener("abort", finish, { once: true });
			});
			const events = collected.slice(0, count);
			const matched = events.length;
			const text = matched === 0
				? `No matching PiBus messages before timeout (${timeoutMs}ms).`
				: matched < count
					? `Got ${matched}/${count} matching PiBus messages before timeout (${timeoutMs}ms):\n${formatEventList(events)}`
					: formatEventList(events);
			return {
				content: [{ type: "text", text }],
				details: { events, matched, requested: count, timedOut: matched < count, satisfied: matched >= count },
			};
		},
	});
}
