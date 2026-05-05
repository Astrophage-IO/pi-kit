import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { PiBusClient } from "../src/client.ts";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_ROOM, DEFAULT_TOPIC, messageTextFromEvent, splitCsv } from "../src/protocol.ts";

type BusEvent = {
	id: string;
	room: string;
	topic: string;
	from?: { connectionId?: string; agentId?: string; name?: string };
	target?: string[];
	text?: string;
	payload?: unknown;
	priority?: string;
	createdAt?: string;
	meta?: Record<string, unknown>;
};

const MAX_INBOX = 200;
const DEFAULT_TOPICS = "*";
const PROCESS_AGENT_ID = `${os.hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

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

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function eventText(event: BusEvent): string {
	return messageTextFromEvent(event as any) || "(no message text)";
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

function formatEventList(events: BusEvent[]): string {
	if (events.length === 0) return "No PiBus messages.";
	return events
		.map((event) => {
			const when = event.createdAt ?? "unknown time";
			const target = event.target && event.target.length > 0 ? ` -> ${event.target.join(",")}` : "";
			return `- [${when}] ${event.room}/${event.topic} ${fromLabel(event)}${target}: ${eventText(event)}`;
		})
		.join("\n");
}

function isAddressedTo(event: BusEvent, agentId: string, agentName: string, connectionId?: string): boolean {
	const target = event.target ?? [];
	return target.includes(agentId) || target.includes(agentName) || Boolean(connectionId && target.includes(connectionId));
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

export default function pibusExtension(pi: ExtensionAPI) {
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
	pi.registerFlag("bus-inject-broadcast", {
		description: "Inject broadcast PiBus events into this agent's conversation context",
		type: "boolean",
		default: envBool("PIBUS_INJECT_BROADCAST", true),
	});
	pi.registerFlag("bus-trigger-addressed", {
		description: "Targeted PiBus messages trigger an agent turn while idle, or steer while streaming",
		type: "boolean",
		default: envBool("PIBUS_TRIGGER_ADDRESSED", true),
	});

	let client: PiBusClient | undefined;
	let currentCtx: ExtensionContext | undefined;
	let connectPromise: Promise<void> | undefined;
	let inbox: BusEvent[] = [];
	let unread = new Set<string>();
	let peers: any[] = [];
	let config = {
		agentId: PROCESS_AGENT_ID,
		agentName: PROCESS_AGENT_ID,
		rooms: [DEFAULT_ROOM],
		topics: ["*"],
		injectBroadcast: true,
		triggerAddressed: true,
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
			injectBroadcast: flagBool(pi, "bus-inject-broadcast", true),
			triggerAddressed: flagBool(pi, "bus-trigger-addressed", true),
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
		const shouldInject = addressed || config.injectBroadcast;
		const shouldTrigger = (addressed && config.triggerAddressed) || event.meta?.trigger === true;
		if (currentCtx?.hasUI && addressed) currentCtx.ui.notify(`PiBus from ${fromLabel(event)}: ${eventText(event).slice(0, 120)}`, "info");
		if (!shouldInject) return;
		try {
			const options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } = {};
			if (shouldTrigger) options.triggerTurn = true;
			if (currentCtx && !currentCtx.isIdle()) options.deliverAs = shouldTrigger ? "steer" : "nextTurn";
			pi.sendMessage(
				{
					customType: "pi-bus.event",
					content: formatEventForLlm(event),
					display: true,
					details: event,
				},
				options,
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

		client.on("online", (welcome: any) => {
			peers = Array.isArray(welcome.peers) ? welcome.peers : [];
			updateStatus(`online ${config.rooms.join(",")}`);
			ctx.ui.notify(`PiBus connected as ${config.agentName} (${config.agentId})`, "info");
		});
		client.on("offline", () => updateStatus("offline"));
		client.on("reconnecting", ({ delay }: any) => updateStatus(`reconnecting in ${Math.round(delay / 1000)}s`));
		client.on("presence", (message: any) => {
			peers = client?.peers ?? peers;
			if (ctx.hasUI && message.action === "join") ctx.ui.notify(`PiBus peer joined: ${message.peer?.name ?? message.peer?.agentId}`, "info");
		});
		client.on("peers", (items: any[]) => (peers = items));
		client.on("bus_event", handleIncoming);
		client.on("bus_error", (message: any) => ctx.ui.notify(`PiBus error: ${message.error ?? safeJson(message)}`, "error"));

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

	function requireClient() {
		if (!client?.isOnline) throw new Error("PiBus is not connected. Start pi-bus-server or run /bus-reconnect.");
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
		updateStatus(undefined);
		client?.close();
		client = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		readConfig(ctx);
		const status = client?.isOnline ? "connected" : "not connected";
		const busPrompt = [
			"PiBus multi-agent event bus is available for coordinating with other pi agents.",
			`PiBus status: ${status}. Your PiBus id/name: ${config.agentId} / ${config.agentName}. Rooms: ${config.rooms.join(", ")}. Subscribed topics: ${config.topics.join(", ")}.`,
			"Use bus_publish for explicit handoffs, questions, discoveries, blockers, and status updates. Use bus_inbox, bus_wait, and bus_agents to read messages and discover peers.",
			"Avoid publishing every internal thought. Publish concise, actionable information and include a target when a specific peer should react.",
		].join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${busPrompt}` };
	});

	pi.registerCommand("bus-reconnect", {
		description: "Reconnect this pi session to the PiBus broker",
		handler: async (_args, ctx) => {
			client?.close();
			client = undefined;
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
				`Peers: ${peers.length}`,
				...peers.map((peer) => `  - ${peer.name ?? peer.agentId} (${peer.agentId}) rooms=${peer.rooms?.join(",") ?? ""}`),
			].join("\n");
			ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("bus-send", {
		description: "Publish a PiBus message. Usage: /bus-send [topic] message",
		handler: async (args, ctx) => {
			await connect(ctx);
			const c = requireClient();
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /bus-send [topic] message", "warning");
				return;
			}
			const parts = trimmed.split(/\s+/);
			const topic = parts.length > 1 && parts[0].includes(".") ? parts.shift()! : DEFAULT_TOPIC;
			const text = parts.join(" ");
			const ack = await c.publish({ room: config.rooms[0] ?? DEFAULT_ROOM, topic, text });
			ctx.ui.notify(`Published ${ack.eventId} to ${ack.recipients} peer(s)`, "info");
		},
	});

	pi.registerCommand("bus-inbox", {
		description: "Show recent PiBus messages",
		handler: async (_args, ctx) => {
			const text = formatEventList(inbox.slice(-50));
			if (ctx.hasUI) await ctx.ui.editor("PiBus inbox", text);
			else ctx.ui.notify(text, "info");
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
			includeSelf: Type.Optional(Type.Boolean({ description: "Whether this agent should receive its own event." })),
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
			if (params.markRead ?? true) for (const event of events) unread.delete(event.id);
			return {
				content: [{ type: "text", text: formatEventList(events) }],
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
			return {
				content: [{ type: "text", text: events.length > 0 ? formatEventList(events) : `No matching PiBus messages before timeout (${timeoutMs}ms).` }],
				details: { events, timedOut: events.length < count },
			};
		},
	});
}
