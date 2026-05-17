import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const PACKAGE_NAME = "@astrophage-io/pi-superpowers";
const PACKAGE_VERSION = "0.1.0";
const DEFAULT_CONFIG_PATH = "~/.pi/agent/superpowers.json";
const MAX_TOOL_NAME_LENGTH = 64;
const BUNDLED_PROMPT_PROFILES = new Set(["slack", "jira", "confluence"]);

interface ServerConfig {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	disabled?: boolean;
}

interface ProfileConfig {
	description?: string;
	servers: string[];
	allowTools?: string[];
	blockTools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt?: string;
	extraArgs?: string[];
}

interface SuperpowersConfig {
	profiles: Record<string, ProfileConfig>;
	servers: Record<string, ServerConfig>;
}

interface ConnectedServer {
	name: string;
	client: Client;
	transport: StdioClientTransport;
}

interface ChildRunResult {
	exitCode: number;
	stdoutEvents: number;
	stderr: string;
	answer: string;
	usage: UsageSummary;
	toolEvents: ToolEventSummary[];
}

interface ToolEventSummary {
	name: string;
	status: "started" | "done" | "error";
}

interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

const ResearchParams = Type.Object({
	question: Type.String({ description: "Question for the specialist agent to answer." }),
	link: Type.Optional(Type.String({ description: "Primary URL/permalink/issue/page to start from." })),
	context: Type.Optional(Type.String({ description: "Additional context, constraints, date range, channel, issue key, etc." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum child-agent runtime in milliseconds. Default: 180000." })),
});

type ResearchParamsType = {
	question: string;
	link?: string;
	context?: string;
	timeoutMs?: number;
};

const SpecialistResearchParams = Type.Object({
	profile: Type.String({ description: "Superpower profile name to use (e.g. slack, jira, confluence, or any profile defined in superpowers.json)." }),
	question: Type.String({ description: "Question for the specialist agent to answer." }),
	link: Type.Optional(Type.String({ description: "Primary URL/permalink/issue/page to start from." })),
	context: Type.Optional(Type.String({ description: "Additional context, constraints, date range, channel, issue key, etc." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum child-agent runtime in milliseconds. Default: 180000." })),
});

type SpecialistResearchParamsType = ResearchParamsType & { profile: string };

interface CachedConfig {
	path: string;
	mtimeMs: number;
	config: SuperpowersConfig;
}

let cachedConfig: CachedConfig | undefined;

function packageRoot(): string {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function bundledAgentPromptPath(profile: string): string {
	return path.join(packageRoot(), "agents", `${profile}-research.md`);
}

function defaultConfigPath(): string {
	return process.env.PI_SUPERPOWERS_CONFIG || DEFAULT_CONFIG_PATH;
}

function registerFlags(pi: ExtensionAPI): void {
	pi.registerFlag("superpower-child", {
		description: "Internal: run this Pi process as an MCP-backed specialist child agent.",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("superpower-profile", {
		description: "Internal: MCP profile for specialist child agent.",
		type: "string",
		default: process.env.PI_SUPERPOWER_PROFILE ?? "",
	});
	pi.registerFlag("superpower-config", {
		description: "Path to superpowers MCP profile config JSON.",
		type: "string",
		default: defaultConfigPath(),
	});
	pi.registerFlag("superpower-verbose", {
		description: "Verbose superpower/MCP logging.",
		type: "boolean",
		default: process.env.PI_SUPERPOWER_VERBOSE === "1",
	});
	pi.registerFlag("superpower-bus", {
		description: "Load the pi-bus extension in specialist child agents so they can publish findings back to the parent over PiBus.",
		type: "boolean",
		default: process.env.PI_SUPERPOWER_BUS === "1",
	});
	pi.registerFlag("superpower-bus-extension", {
		description: "Path to the pi-bus extension entry to load in child specialists. Defaults to the @astrophage-io/pi-bus install if resolvable.",
		type: "string",
		default: process.env.PI_SUPERPOWER_BUS_EXTENSION ?? "",
	});
}

function flagString(pi: ExtensionAPI, name: string, fallback = ""): string {
	const value = pi.getFlag(name);
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function flagBool(pi: ExtensionAPI, name: string, fallback = false): boolean {
	const value = pi.getFlag(name);
	return typeof value === "boolean" ? value : fallback;
}

export default function superpowersExtension(pi: ExtensionAPI) {
	registerFlags(pi);

	const isChildAtLoad = flagBool(pi, "superpower-child", false);
	const connectedServers: ConnectedServer[] = [];
	let childToolNames: string[] = [];
	let childInitPromise: Promise<void> | undefined;

	if (!isChildAtLoad) registerResearchTools(pi);

	pi.on("session_start", async (_event, ctx) => {
		if (!flagBool(pi, "superpower-child", false)) return;
		childInitPromise ??= initializeChildProfile(pi, ctx, connectedServers).then((toolNames) => {
			childToolNames = toolNames;
			pi.setActiveTools(toolNames);
		});
		await childInitPromise;
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!flagBool(pi, "superpower-child", false)) return;
		const profile = flagString(pi, "superpower-profile", "unknown");
		const lines = [
			`You are running as a dedicated ${profile} specialist child agent spawned by a parent Pi session.`,
			"Use the available MCP tools to gather evidence and answer the task. Do not call parent-agent tools or spawn other specialists.",
			childToolNames.length > 0 ? `Active MCP tools: ${childToolNames.join(", ")}` : "No MCP tools are active; report this as a configuration problem.",
		];
		if (process.env.PIBUS_AUTOSTART && process.env.PIBUS_AUTOSTART !== "0") {
			lines.push(
				"PiBus is available: you can publish concise progress updates or findings back to the parent via bus_publish (topic agent.status or agent.handoff). Inbound events are buffered, not pushed, so they will not steal context unless you call bus_inbox.",
			);
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n")}` };
	});

	pi.on("session_shutdown", async () => {
		await Promise.allSettled(
			connectedServers.map(async (server) => {
				try {
					await server.client.close();
				} catch {
					try {
						await server.transport.close();
					} catch {
						// ignore shutdown errors
					}
				}
			}),
		);
		connectedServers.length = 0;
	});
}

function registerResearchTools(pi: ExtensionAPI): void {
	const configPath = resolvePath(flagString(pi, "superpower-config", defaultConfigPath()));
	const config = tryReadConfigSync(configPath);
	const registered = new Set<string>();

	const builtins: Array<{ profile: string; description: string; guidelines: string[] }> = [
		{
			profile: "slack",
			description: "Spawn a dedicated Slack research Pi agent that answers questions from Slack threads, links, and searches using MCP tools.",
			guidelines: [
				"Use slack_research when the user asks about Slack links, threads, channel discussions, incident conversations, decisions, or who said what in Slack.",
				"slack_research returns an evidence-backed answer; do not ask it to merely dump transcripts unless the user explicitly requests that.",
			],
		},
		{
			profile: "jira",
			description: "Spawn a dedicated Jira research Pi agent that answers questions from Jira issues, comments, relationships, and searches using MCP tools.",
			guidelines: ["Use jira_research when the user asks about Jira issues, tickets, status, blockers, ownership, comments, or related issue context."],
		},
		{
			profile: "confluence",
			description: "Spawn a dedicated Confluence research Pi agent that answers questions from Confluence pages and searches using MCP tools.",
			guidelines: ["Use confluence_research when the user asks about Confluence pages, design docs, runbooks, RFCs, or documented decisions."],
		},
	];
	for (const builtin of builtins) {
		const name = `${builtin.profile}_research`;
		registerResearchTool(pi, {
			name,
			label: `${capitalize(builtin.profile)} Research`,
			profile: builtin.profile,
			description: builtin.description,
			guidelines: builtin.guidelines,
		});
		registered.add(name);
	}

	if (config) {
		for (const [profileName, profile] of Object.entries(config.profiles)) {
			const name = `${sanitizeProfileName(profileName)}_research`;
			if (registered.has(name)) continue;
			registerResearchTool(pi, {
				name,
				label: `${capitalize(profileName)} Research`,
				profile: profileName,
				description: profile.description ?? `Spawn a dedicated ${profileName} research Pi agent backed by MCP tools from the ${profileName} superpower profile.`,
				guidelines: [`Use ${name} when the user asks for evidence that ${profileName} MCP tools can provide.`],
			});
			registered.add(name);
		}
	}

	pi.registerTool({
		name: "specialist_research",
		label: "Specialist Research",
		description: "Spawn a dedicated specialist Pi agent for any configured superpower profile. Use when you want to pick the profile by name at call time, e.g. for custom profiles not exposed as a dedicated tool.",
		promptSnippet: "Run a specialist Pi research agent using any configured superpower profile by name",
		promptGuidelines: [
			"Use specialist_research when none of the dedicated *_research tools fits, but a profile in superpowers.json does.",
			"Pass the profile name exactly as it appears in superpowers.json.",
		],
		parameters: SpecialistResearchParams,
		async execute(_toolCallId, params: SpecialistResearchParamsType, signal, onUpdate, ctx) {
			const result = await runSpecialistAgent(pi, params.profile, params, signal, onUpdate, ctx);
			return {
				content: [{ type: "text", text: result.answer || "(specialist returned no answer)" }],
				details: {
					profile: params.profile,
					exitCode: result.exitCode,
					usage: result.usage,
					toolEvents: result.toolEvents,
					stderr: result.stderr,
				},
			};
		},
	});
}

function tryReadConfigSync(configPath: string): SuperpowersConfig | undefined {
	try {
		const text = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(text);
		if (!isRecord(parsed) || !isRecord(parsed.profiles) || !isRecord(parsed.servers)) return undefined;
		return parsed as unknown as SuperpowersConfig;
	} catch {
		return undefined;
	}
}

function sanitizeProfileName(value: string): string {
	const sanitized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return sanitized || "profile";
}

function capitalize(value: string): string {
	if (!value) return value;
	return value[0]!.toUpperCase() + value.slice(1);
}

function registerResearchTool(
	pi: ExtensionAPI,
	definition: {
		name: string;
		label: string;
		profile: string;
		description: string;
		guidelines: string[];
	},
): void {
	pi.registerTool({
		name: definition.name,
		label: definition.label,
		description: definition.description,
		promptSnippet: definition.description,
		promptGuidelines: definition.guidelines,
		parameters: ResearchParams,
		async execute(_toolCallId, params: ResearchParamsType, signal, onUpdate, ctx) {
			const result = await runSpecialistAgent(pi, definition.profile, params, signal, onUpdate, ctx);
			return {
				content: [{ type: "text", text: result.answer || "(specialist returned no answer)" }],
				details: {
					profile: definition.profile,
					exitCode: result.exitCode,
					usage: result.usage,
					toolEvents: result.toolEvents,
					stderr: result.stderr,
				},
			};
		},
	});
}

async function initializeChildProfile(pi: ExtensionAPI, ctx: ExtensionContext, connectedServers: ConnectedServer[]): Promise<string[]> {
	const profileName = flagString(pi, "superpower-profile");
	if (!profileName) throw new Error("Missing --superpower-profile for specialist child agent");
	const configPath = resolvePath(flagString(pi, "superpower-config", defaultConfigPath()));
	const config = await getConfig(configPath);
	const profile = config.profiles[profileName];
	if (!profile) throw new Error(`Unknown superpower profile: ${profileName}. Available profiles: ${Object.keys(config.profiles).join(", ") || "none"}`);
	const verbose = flagBool(pi, "superpower-verbose", false);
	const toolNames: string[] = [];
	const usedNames = new Set<string>();

	for (const serverName of profile.servers) {
		const serverConfig = config.servers[serverName];
		if (!serverConfig) throw new Error(`Profile ${profileName} references unknown MCP server: ${serverName}`);
		if (serverConfig.disabled) continue;
		const connected = await connectMcpServer(serverName, serverConfig, path.dirname(configPath));
		connectedServers.push(connected);
		const listed = await connected.client.listTools();
		const tools = Array.isArray(listed.tools) ? listed.tools : [];
		for (const tool of tools) {
			if (!tool?.name) continue;
			const registeredName = makePiToolName(serverName, tool.name, usedNames);
			if (!isToolAllowed(serverName, tool.name, registeredName, profile)) continue;
			usedNames.add(registeredName);
			registerMcpTool(pi, connected, tool, registeredName, verbose);
			toolNames.push(registeredName);
		}
	}

	if (toolNames.length === 0) {
		throw new Error(`Profile ${profileName} exposed no MCP tools. Check allowTools/blockTools and server configuration in ${configPath}.`);
	}
	ctx.ui.setStatus("superpower", `${profileName}: ${toolNames.length} MCP tools`);
	return toolNames;
}

async function connectMcpServer(name: string, config: ServerConfig, configDir: string): Promise<ConnectedServer> {
	if (!config.command) throw new Error(`MCP server ${name} is missing command`);
	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	for (const [key, value] of Object.entries(config.env ?? {})) {
		const expanded = expandValue(value);
		if (expanded !== undefined) env[key] = expanded;
	}
	const transport = new StdioClientTransport({
		command: expandValue(config.command) ?? config.command,
		args: (config.args ?? []).map((arg) => expandValue(arg) ?? arg),
		cwd: config.cwd ? resolvePath(config.cwd, configDir) : undefined,
		env,
	});
	const client = new Client(
		{ name: `${PACKAGE_NAME}:${name}`, version: PACKAGE_VERSION },
		{ capabilities: {} },
	);
	await client.connect(transport);
	return { name, client, transport };
}

function registerMcpTool(pi: ExtensionAPI, server: ConnectedServer, tool: McpTool, registeredName: string, verbose: boolean): void {
	const inputSchema = normalizeInputSchema(tool.inputSchema);
	pi.registerTool({
		name: registeredName,
		label: `MCP ${server.name}/${tool.name}`,
		description: [
			`MCP tool ${tool.name} from server ${server.name}.`,
			tool.description ?? "",
		].filter(Boolean).join(" "),
		promptSnippet: tool.description ? `${server.name}/${tool.name}: ${tool.description}` : `${server.name}/${tool.name}`,
		parameters: inputSchema,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw abortError(signal);
			if (verbose) console.error(`[pi-superpowers] MCP call ${server.name}/${tool.name}`);
			const result = await server.client.callTool(
				{ name: tool.name, arguments: params as Record<string, unknown> },
				undefined,
				{ signal },
			);
			const text = mcpResultToText(result);
			if (isMcpErrorResult(result)) throw new Error(text || `MCP tool ${tool.name} returned an error`);
			return {
				content: [{ type: "text", text: text || "(MCP tool returned no text content)" }],
				details: { server: server.name, tool: tool.name, result },
			};
		},
	});
}

async function runSpecialistAgent(
	pi: ExtensionAPI,
	profileName: string,
	params: ResearchParamsType,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
	ctx: ExtensionContext,
): Promise<ChildRunResult> {
	const configPath = resolvePath(flagString(pi, "superpower-config", defaultConfigPath()));
	const config = await getConfig(configPath);
	const profile = config.profiles[profileName];
	if (!profile) throw new Error(`Unknown superpower profile: ${profileName}. Configure it in ${configPath}.`);
	const prompt = await loadSpecialistPrompt(profileName, profile, configPath);
	const task = formatSpecialistTask(params);
	const extensionPath = fileURLToPath(import.meta.url);
	const busExtension = resolveBusExtension(pi);
	const args = [
		"--mode", "json",
		"-p",
		"--no-session",
		"--no-builtin-tools",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"-e", extensionPath,
	];
	if (busExtension) args.push("-e", busExtension);
	args.push(
		"--superpower-child=true",
		"--superpower-profile", profileName,
		"--superpower-config", configPath,
		"--system-prompt", prompt,
	);
	if (profile.model) args.push("--model", profile.model);
	if (profile.thinking) args.push("--thinking", profile.thinking);
	if (profile.extraArgs) args.push(...profile.extraArgs);
	args.push(task);

	const env = buildChildEnv(profileName, busExtension);

	return runPiJsonProcess(args, {
		cwd: ctx.cwd,
		timeoutMs: normalizeTimeout(params.timeoutMs),
		signal,
		onUpdate,
		profileName,
		env,
	});
}

function resolveBusExtension(pi: ExtensionAPI): string | undefined {
	if (!flagBool(pi, "superpower-bus", false)) return undefined;
	const explicit = flagString(pi, "superpower-bus-extension", "");
	if (explicit) {
		const resolved = resolvePath(explicit);
		if (existsSync(resolved)) return resolved;
		throw new Error(`--superpower-bus-extension does not exist: ${resolved}`);
	}
	const requireFn = createRequire(import.meta.url);
	try {
		const pkgPath = requireFn.resolve("@astrophage-io/pi-bus/package.json");
		const pkgDir = path.dirname(pkgPath);
		const candidate = path.join(pkgDir, "extensions", "pi-bus.ts");
		if (existsSync(candidate)) return candidate;
	} catch {
		// fall through to monorepo fallback
	}
	const monorepoCandidate = path.resolve(packageRoot(), "..", "pi-bus", "extensions", "pi-bus.ts");
	if (existsSync(monorepoCandidate)) return monorepoCandidate;
	throw new Error("Could not locate pi-bus extension. Install @astrophage-io/pi-bus or pass --superpower-bus-extension <path>.");
}

function buildChildEnv(profileName: string, busExtension: string | undefined): Record<string, string> {
	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	if (!busExtension) return env;
	const parentName = process.env.PIBUS_NAME || `${path.basename(process.cwd()) || "pi"}:${process.pid}`;
	env.PIBUS_AUTOSTART = process.env.PIBUS_AUTOSTART ?? "1";
	env.PIBUS_AGENT = `${parentName}:${profileName}:${process.pid}-${Date.now().toString(36)}`;
	env.PIBUS_NAME = `${parentName}/${profileName}`;
	env.PIBUS_ROOM = process.env.PIBUS_ROOM ?? "default";
	env.PIBUS_TOPICS = process.env.PIBUS_TOPICS ?? "*";
	env.PIBUS_PUSH = process.env.PIBUS_PUSH ?? "off";
	env.PIBUS_TRIGGER = process.env.PIBUS_TRIGGER ?? "off";
	return env;
}

async function runPiJsonProcess(
	args: string[],
	options: {
		cwd: string;
		timeoutMs: number;
		signal?: AbortSignal;
		onUpdate?: ((partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined;
		profileName: string;
		env?: Record<string, string>;
	},
): Promise<ChildRunResult> {
	const invocation = getPiInvocation(args);
	const usage: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	const toolEvents: ToolEventSummary[] = [];
	let stdoutEvents = 0;
	let stderr = "";
	let answer = "";
	let lineBuffer = "";
	let timedOut = false;

	const emitUpdate = (status: string) => {
		options.onUpdate?.({
			content: [{ type: "text", text: status }],
			details: { profile: options.profileName, usage, toolEvents: [...toolEvents], answer },
		});
	};

	emitUpdate(`${options.profileName} specialist starting...`);

	const exitCode = await new Promise<number>((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], env: options.env });
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
		}, options.timeoutMs);
		timeout.unref?.();

		const abort = () => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
		};
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });

		child.stdout?.on("data", (chunk: Buffer | string) => {
			lineBuffer += chunk.toString();
			while (true) {
				const newline = lineBuffer.indexOf("\n");
				if (newline < 0) break;
				const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
				lineBuffer = lineBuffer.slice(newline + 1);
				processJsonEventLine(line);
			}
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
			if (lineBuffer.trim()) processJsonEventLine(lineBuffer);
			resolve(code ?? 0);
		});
	});

	if (options.signal?.aborted) throw abortError(options.signal);
	if (timedOut) throw new Error(`${options.profileName} specialist timed out after ${options.timeoutMs}ms`);
	if (exitCode !== 0) throw new Error(`${options.profileName} specialist exited with code ${exitCode}${stderr ? `\n${stderr.trim()}` : ""}`);
	return { exitCode, stdoutEvents, stderr, answer, usage, toolEvents };

	function processJsonEventLine(line: string): void {
		if (!line.trim()) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(event)) return;
		stdoutEvents++;
		if (event.type === "tool_execution_start") {
			const name = typeof event.toolName === "string" ? event.toolName : "tool";
			toolEvents.push({ name, status: "started" });
			emitUpdate(`${options.profileName} specialist using ${name}...`);
			return;
		}
		if (event.type === "tool_execution_end") {
			const name = typeof event.toolName === "string" ? event.toolName : "tool";
			const isError = event.isError === true;
			toolEvents.push({ name, status: isError ? "error" : "done" });
			emitUpdate(`${options.profileName} specialist ${isError ? "failed" : "finished"} ${name}...`);
			return;
		}
		if (event.type === "message_end" && isRecord(event.message)) {
			const message = event.message;
			if (message.role === "assistant") {
				usage.turns++;
				answer = extractMessageText(message) || answer;
				addUsage(usage, message.usage);
				if (answer) emitUpdate(answer);
			}
			return;
		}
		if (event.type === "agent_end" && Array.isArray(event.messages)) {
			const finalText = extractLastAssistantText(event.messages);
			if (finalText) answer = finalText;
			if (answer) emitUpdate(answer);
		}
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function loadSpecialistPrompt(profileName: string, profile: ProfileConfig, configPath: string): Promise<string> {
	if (profile.systemPrompt) {
		const resolved = resolvePath(profile.systemPrompt, path.dirname(configPath));
		return readFile(resolved, "utf8");
	}
	return readFile(bundledAgentPromptPath(profileName), "utf8");
}

function formatSpecialistTask(params: ResearchParamsType): string {
	return [
		"Specialist research task from parent Pi agent.",
		`Question: ${params.question}`,
		params.link ? `Primary link/key/page: ${params.link}` : "",
		params.context ? `Additional context: ${params.context}` : "",
	].filter(Boolean).join("\n\n");
}

async function loadConfig(configPath: string): Promise<SuperpowersConfig> {
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		throw new Error(`Could not read superpowers config at ${configPath}. Copy packages/pi-superpowers/config/superpowers.example.json to ${DEFAULT_CONFIG_PATH} and edit it. Cause: ${errorMessage(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid superpowers config JSON at ${configPath}: ${errorMessage(error)}`);
	}
	if (!isRecord(parsed) || !isRecord(parsed.profiles) || !isRecord(parsed.servers)) {
		throw new Error(`Invalid superpowers config at ${configPath}: expected { profiles, servers } objects`);
	}
	return parsed as unknown as SuperpowersConfig;
}

async function getConfig(configPath: string): Promise<SuperpowersConfig> {
	let mtimeMs: number | undefined;
	try {
		const stats = await stat(configPath);
		mtimeMs = stats.mtimeMs;
	} catch {
		mtimeMs = undefined;
	}
	if (cachedConfig && cachedConfig.path === configPath && mtimeMs !== undefined && cachedConfig.mtimeMs === mtimeMs) {
		return cachedConfig.config;
	}
	const config = await loadConfig(configPath);
	if (mtimeMs !== undefined) cachedConfig = { path: configPath, mtimeMs, config };
	return config;
}

export function _resetConfigCacheForTesting(): void {
	cachedConfig = undefined;
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
	if (isRecord(schema)) return schema;
	return { type: "object", additionalProperties: true };
}

function makePiToolName(serverName: string, toolName: string, usedNames: Set<string>): string {
	const base = sanitizeToolName(`mcp_${serverName}_${toolName}`);
	const hash = createHash("sha1").update(`${serverName}/${toolName}`).digest("hex").slice(0, 8);
	let candidate = base.length <= MAX_TOOL_NAME_LENGTH ? base : `${base.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${hash}`;
	let index = 2;
	while (usedNames.has(candidate)) {
		const suffix = `_${index++}`;
		candidate = `${candidate.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
	}
	return candidate;
}

function sanitizeToolName(value: string): string {
	const sanitized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_");
	return sanitized || "mcp_tool";
}

function isToolAllowed(serverName: string, toolName: string, registeredName: string, profile: ProfileConfig): boolean {
	const allow = profile.allowTools && profile.allowTools.length > 0 ? profile.allowTools : ["*"];
	const blocked = profile.blockTools ?? [];
	const allowed = allow.some((pattern) => matchesToolPattern(pattern, serverName, toolName, registeredName));
	const denied = blocked.some((pattern) => matchesToolPattern(pattern, serverName, toolName, registeredName));
	return allowed && !denied;
}

function matchesToolPattern(pattern: string, serverName: string, toolName: string, registeredName: string): boolean {
	const normalizedPattern = pattern.trim().toLowerCase();
	if (!normalizedPattern) return false;
	const candidates = [
		toolName,
		registeredName,
		`${serverName}/${toolName}`,
		`${serverName}:${toolName}`,
		`${serverName}.${toolName}`,
	].map((candidate) => candidate.toLowerCase());
	if (normalizedPattern === "*") return true;
	if (normalizedPattern.includes("*")) {
		const regex = new RegExp(`^${escapeRegex(normalizedPattern).replace(/\\\*/g, ".*")}$`);
		return candidates.some((candidate) => regex.test(candidate));
	}
	return candidates.includes(normalizedPattern);
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}

function mcpResultToText(result: unknown): string {
	if (!isRecord(result)) return safeJson(result);
	const content = result.content;
	if (!Array.isArray(content)) return safeJson(result);
	return content.map((item) => mcpContentItemToText(item)).filter(Boolean).join("\n");
}

function mcpContentItemToText(item: unknown): string {
	if (!isRecord(item)) return safeJson(item);
	if (item.type === "text" && typeof item.text === "string") return item.text;
	if (item.type === "image") {
		const mimeType = typeof item.mimeType === "string" ? item.mimeType : "unknown image";
		return `[MCP image content: ${mimeType}]`;
	}
	if (item.type === "resource") return `[MCP resource content]\n${safeJson(item.resource ?? item)}`;
	return safeJson(item);
}

function isMcpErrorResult(result: unknown): boolean {
	return isRecord(result) && result.isError === true;
}

function extractLastAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isRecord(message) && message.role === "assistant") {
			const text = extractMessageText(message);
			if (text) return text;
		}
	}
	return "";
}

function extractMessageText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") texts.push(part.text);
	}
	return texts.join("\n").trim();
}

function addUsage(summary: UsageSummary, usage: unknown): void {
	if (!isRecord(usage)) return;
	summary.input += numberField(usage.input);
	summary.output += numberField(usage.output);
	summary.cacheRead += numberField(usage.cacheRead);
	summary.cacheWrite += numberField(usage.cacheWrite);
	if (isRecord(usage.cost)) summary.cost += numberField(usage.cost.total);
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeTimeout(value: number | undefined): number {
	if (value === undefined) return 180_000;
	if (!Number.isFinite(value) || value <= 0) throw new Error("timeoutMs must be a positive number");
	return Math.max(1_000, Math.min(Math.trunc(value), 600_000));
}

function resolvePath(value: string, baseDir = process.cwd()): string {
	const expanded = expandValue(value) ?? value;
	if (expanded.startsWith("~/")) return path.join(os.homedir(), expanded.slice(2));
	if (expanded === "~") return os.homedir();
	return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function expandValue(value: string): string | undefined {
	if (value.startsWith("$") && /^\$[A-Z_][A-Z0-9_]*$/.test(value)) {
		return process.env[value.slice(1)];
	}
	return value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_match, name: string) => process.env[name] ?? "");
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(signal.reason ? String(signal.reason) : "Operation aborted");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function writeExampleConfig(target = resolvePath(DEFAULT_CONFIG_PATH)): Promise<string> {
	const source = path.join(packageRoot(), "config", "superpowers.example.json");
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, await readFile(source, "utf8"), "utf8");
	return target;
}

export async function removeExampleConfig(target = resolvePath(DEFAULT_CONFIG_PATH)): Promise<void> {
	await rm(target, { force: true });
}

export const _internals = {
	addUsage,
	buildChildEnv,
	expandValue,
	extractLastAssistantText,
	extractMessageText,
	isToolAllowed,
	loadConfig,
	makePiToolName,
	matchesToolPattern,
	mcpResultToText,
	resolvePath,
	sanitizeProfileName,
	sanitizeToolName,
	tryReadConfigSync,
};
