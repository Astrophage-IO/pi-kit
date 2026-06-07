import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceSource } from "./claims.ts";
import type { InvestigationPaths } from "./investigation.ts";

export type ReadinessStatus =
	| "ready" // live-verified: MCP connected and exposed tools (or a non-MCP source like repo)
	| "configured" // statically configured; not yet live-verified (optimistic, used when live=false)
	| "missing-config"
	| "missing-profile"
	| "missing-server"
	| "no-tools" // connected but the server exposed zero tools
	| "connect-failed"; // could not reach/start the MCP server

/** Sources that need an MCP server (via pi-superpowers profiles); `repo` uses built-in tools. */
export const MCP_SOURCES: ReadonlySet<EvidenceSource> = new Set<EvidenceSource>(["slack", "jira", "confluence"]);

export interface SourceReadiness {
	source: EvidenceSource;
	/** Profile name expected in superpowers.json (defaults to the source name). */
	profile: string;
	ready: boolean;
	status: ReadinessStatus;
	detail: string;
	missingEnv?: string[];
	toolCount?: number;
	/** True when the human chose to proceed without this source. */
	skipped?: boolean;
}

export interface ReadinessReport {
	updatedAt: string;
	confirmedAt?: string;
	configPath: string;
	sources: SourceReadiness[];
}

interface ServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	disabled?: boolean;
}

interface ProfileConfig {
	servers?: string[];
}

export interface SuperpowersConfig {
	profiles: Record<string, ProfileConfig>;
	servers: Record<string, ServerConfig>;
}

export function profileForSource(source: EvidenceSource): string {
	return source;
}

export function parseSuperpowersConfig(text: string): SuperpowersConfig | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.profiles) || !isRecord(parsed.servers)) return undefined;
		return parsed as unknown as SuperpowersConfig;
	} catch {
		return undefined;
	}
}

const ENV_REF = /\$\{?([A-Z_][A-Z0-9_]*)\}?/g;

function collectEnvRefs(value: string, into: Set<string>): void {
	for (const match of value.matchAll(ENV_REF)) into.add(match[1]!);
}

/**
 * Env var names a profile's servers reference (in command/args/env values). These are advisory
 * only: an MCP server may authenticate via an already-logged-in CLI or OAuth and need none of
 * them. The live connect probe — not these env vars — is the source of truth for availability.
 */
export function collectReferencedEnv(config: SuperpowersConfig, profileName: string): string[] {
	const profile = config.profiles[profileName];
	const names = new Set<string>();
	for (const serverName of profile?.servers ?? []) {
		const server = config.servers[serverName];
		if (!server) continue;
		if (server.command) collectEnvRefs(server.command, names);
		for (const arg of server.args ?? []) collectEnvRefs(arg, names);
		for (const value of Object.values(server.env ?? {})) collectEnvRefs(value, names);
	}
	return [...names];
}

export interface StaticReadinessOptions {
	env?: Record<string, string | undefined>;
}

/**
 * Static readiness (no process spawn): is the MCP structurally configured (config present, profile
 * defined, servers defined+enabled)? Availability is NOT decided by env vars — an MCP may use CLI
 * or OAuth auth. A structurally-configured source is `configured` but NOT yet usable: only a live
 * connect (the probe in `investigation_preflight`) can mark an MCP source `ready` and open the
 * kickoff gate. Unset referenced env vars are attached as an advisory hint only.
 */
export function staticReadiness(
	config: SuperpowersConfig | undefined,
	source: EvidenceSource,
	options: StaticReadinessOptions = {},
): SourceReadiness {
	const profile = profileForSource(source);
	if (!MCP_SOURCES.has(source)) {
		return { source, profile, ready: true, status: "ready", detail: "built-in tools (no MCP required)" };
	}
	if (!config) {
		return { source, profile, ready: false, status: "missing-config", detail: "no superpowers/MCP config found" };
	}
	if (!config.profiles[profile]) {
		return { source, profile, ready: false, status: "missing-profile", detail: `no '${profile}' MCP profile configured` };
	}
	const servers = config.profiles[profile]?.servers ?? [];
	for (const serverName of servers) {
		const server = config.servers[serverName];
		if (!server) return { source, profile, ready: false, status: "missing-server", detail: `profile '${profile}' references undefined server '${serverName}'` };
		if (server.disabled) return { source, profile, ready: false, status: "missing-server", detail: `MCP server '${serverName}' is disabled` };
	}
	const env = options.env ?? process.env;
	const missingEnv = collectReferencedEnv(config, profile).filter((name) => !env[name]);
	const note = missingEnv.length > 0 ? ` (note: ${missingEnv.join(", ")} unset — may be needed unless the server authenticates via CLI/OAuth)` : "";
	return {
		source,
		profile,
		ready: false,
		status: "configured",
		detail: `MCP profile '${profile}' configured; run a live preflight to verify it is reachable${note}`,
		missingEnv: missingEnv.length > 0 ? missingEnv : undefined,
	};
}

export function resolveSuperpowersConfigPath(explicit: string | undefined, env: Record<string, string | undefined> = process.env): string {
	const raw = explicit && explicit.length > 0 ? explicit : env.PI_SUPERPOWERS_CONFIG ?? "~/.pi/agent/superpowers.json";
	if (raw === "~") return process.env.HOME ?? raw;
	if (raw.startsWith("~/")) return path.join(process.env.HOME ?? "", raw.slice(2));
	return raw;
}

export async function loadSuperpowersConfig(configPath: string): Promise<SuperpowersConfig | undefined> {
	if (!existsSync(configPath)) return undefined;
	try {
		return parseSuperpowersConfig(await readFile(configPath, "utf8"));
	} catch {
		return undefined;
	}
}

export async function readReadiness(paths: InvestigationPaths): Promise<ReadinessReport | undefined> {
	if (!existsSync(paths.readiness)) return undefined;
	try {
		return JSON.parse(await readFile(paths.readiness, "utf8")) as ReadinessReport;
	} catch {
		return undefined;
	}
}

export async function writeReadiness(paths: InvestigationPaths, report: ReadinessReport): Promise<void> {
	await mkdir(paths.dir, { recursive: true });
	await writeFile(paths.readiness, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/** Whether a source can be used to spawn work: ready and not skipped by the human. */
export function sourceUsable(report: ReadinessReport | undefined, source: EvidenceSource): boolean {
	const entry = report?.sources.find((item) => item.source === source);
	return Boolean(entry && entry.ready && !entry.skipped);
}

/** Required sources that are neither ready nor explicitly skipped — these block confirmation. */
export function unmetSources(report: ReadinessReport): SourceReadiness[] {
	return report.sources.filter((item) => !item.ready && !item.skipped);
}

export function isConfirmed(report: ReadinessReport | undefined): boolean {
	return Boolean(report?.confirmedAt);
}

export function renderReadiness(report: ReadinessReport): string {
	const lines = [`investigation readiness (config: ${report.configPath})`];
	for (const entry of report.sources) {
		const mark = entry.skipped ? "skip" : entry.ready ? " ok " : "MISS";
		const tools = entry.toolCount !== undefined ? ` [${entry.toolCount} tools]` : "";
		lines.push(`  [${mark}] ${entry.source}: ${entry.status} — ${entry.detail}${tools}`);
	}
	lines.push(report.confirmedAt ? `confirmed at ${report.confirmedAt}` : "not confirmed — kickoff is gated until confirmation");
	return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
