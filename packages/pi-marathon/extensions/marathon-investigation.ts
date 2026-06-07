import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
	appendClaim,
	appendVerdict,
	evaluateClaim,
	makeClaimId,
	parseClaimsBlock,
	parseVerdictBlock,
	readClaims,
	readVerdicts,
	type Claim,
	type EvidenceSource,
} from "../src/claims.ts";
import {
	compileReports,
	ensureInvestigation,
	investigationPaths,
	reportFileFor,
	writeBrief,
	type InvestigationPaths,
} from "../src/investigation.ts";
import {
	MCP_SOURCES as MCP_SOURCE_SET,
	isConfirmed,
	loadSuperpowersConfig,
	readReadiness,
	renderReadiness,
	resolveSuperpowersConfigPath,
	sourceUsable,
	staticReadiness,
	unmetSources,
	writeReadiness,
	type ReadinessReport,
	type SourceReadiness,
	type SuperpowersConfig,
} from "../src/readiness.ts";

const DEFAULT_VERIFIERS = 5;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_SPAWN_TIMEOUT_MS = 300_000;

const SOURCE_SUBSKILL: Record<EvidenceSource, string> = {
	slack: "evidence-slack",
	jira: "evidence-jira",
	confluence: "evidence-confluence",
	repo: "evidence-repo",
	other: "evidence-repo",
};
const MCP_SOURCES = new Set<EvidenceSource>(["slack", "jira", "confluence"]);

function packageRoot(): string {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function subskillPromptPath(name: string): string {
	return path.join(packageRoot(), "skills", name, "SKILL.md");
}

function flagString(pi: ExtensionAPI, name: string, fallback: string): string {
	const value = pi.getFlag(name);
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function flagNumber(pi: ExtensionAPI, name: string, fallback: number): number {
	const value = Number(flagString(pi, name, String(fallback)));
	return Number.isFinite(value) ? value : fallback;
}

function stripFrontmatter(markdown: string): string {
	if (!markdown.startsWith("---")) return markdown;
	const end = markdown.indexOf("\n---", 3);
	if (end < 0) return markdown;
	const afterNewline = markdown.indexOf("\n", end + 1);
	return afterNewline < 0 ? "" : markdown.slice(afterNewline + 1).replace(/^\s+/, "");
}

async function loadSubskill(name: string): Promise<string> {
	const file = subskillPromptPath(name);
	if (!existsSync(file)) throw new Error(`Missing subskill prompt: ${file}`);
	return stripFrontmatter(await readFile(file, "utf8"));
}

interface HeadlessOptions {
	childPi: string;
	systemPrompt: string;
	appendSystemPrompt?: string;
	task: string;
	extraArgs?: string[];
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

interface HeadlessResult {
	answer: string;
	exitCode: number;
	timedOut: boolean;
	killedSignal: NodeJS.Signals | null;
	stderr: string;
}

/** Spawn a headless `pi --mode json -p` child and return only its final assistant message text. */
async function runHeadlessAgent(options: HeadlessOptions): Promise<HeadlessResult> {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-context-files",
		"--no-prompt-templates",
		"--no-skills",
		...(options.extraArgs ?? []),
		"--system-prompt",
		options.systemPrompt,
	];
	if (options.appendSystemPrompt) args.push("--append-system-prompt", options.appendSystemPrompt);
	args.push(options.task);

	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let killedSignal: NodeJS.Signals | null = null;

	const exitCode = await new Promise<number>((resolve, reject) => {
		const child = spawn(options.childPi, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
		}, options.timeoutMs);
		timer.unref?.();
		const onAbort = () => child.kill("SIGTERM");
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk: Buffer | string) => (stdout += chunk.toString()));
		child.stderr?.on("data", (chunk: Buffer | string) => (stderr += chunk.toString()));
		child.on("error", (error) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			killedSignal = signal ?? null;
			resolve(code ?? (signal ? -1 : 0));
		});
	});

	return { answer: extractFinalAnswer(stdout), exitCode, timedOut, killedSignal, stderr };
}

function extractFinalAnswer(stdout: string): string {
	let answer = "";
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(event)) continue;
		if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
			const text = extractMessageText(event.message);
			if (text) answer = text;
		} else if (event.type === "agent_end" && Array.isArray(event.messages)) {
			for (let i = event.messages.length - 1; i >= 0; i--) {
				const message = event.messages[i];
				if (isRecord(message) && message.role === "assistant") {
					const text = extractMessageText(message);
					if (text) {
						answer = text;
						break;
					}
				}
			}
		}
	}
	return answer;
}

function extractMessageText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
	const limit = Math.max(1, concurrency);
	let cursor = 0;
	async function next(): Promise<void> {
		const index = cursor++;
		if (index >= items.length) return;
		await worker(items[index]!, index);
		await next();
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
}

function specialistExtraArgs(pi: ExtensionAPI, source: EvidenceSource): string[] {
	const superpowers = flagString(pi, "marathon-superpowers", "");
	if (superpowers && MCP_SOURCES.has(source)) {
		return ["-e", superpowers, "--superpower-child=true", "--superpower-profile", source];
	}
	return [];
}

function expandEnvValue(value: string): string | undefined {
	if (/^\$[A-Z_][A-Z0-9_]*$/.test(value)) return process.env[value.slice(1)];
	return value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_match, name: string) => process.env[name] ?? "");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
			timer.unref?.();
		}),
	]);
}

/** Live MCP probe: actually start each server the profile references and list its tools. */
async function probeLiveProfile(config: SuperpowersConfig, profile: string, timeoutMs: number): Promise<{ toolCount: number } | { error: string }> {
	let ClientMod: typeof import("@modelcontextprotocol/sdk/client/index.js");
	let StdioMod: typeof import("@modelcontextprotocol/sdk/client/stdio.js");
	try {
		ClientMod = await import("@modelcontextprotocol/sdk/client/index.js");
		StdioMod = await import("@modelcontextprotocol/sdk/client/stdio.js");
	} catch {
		return { error: "MCP SDK not installed; static check only" };
	}
	const servers = config.profiles[profile]?.servers ?? [];
	let toolCount = 0;
	for (const name of servers) {
		const server = config.servers[name];
		if (!server || server.disabled || !server.command) return { error: `server '${name}' unavailable` };
		const env: Record<string, string> = { ...process.env } as Record<string, string>;
		for (const [key, value] of Object.entries(server.env ?? {})) {
			const expanded = expandEnvValue(value);
			if (expanded !== undefined) env[key] = expanded;
		}
		const transport = new StdioMod.StdioClientTransport({
			command: expandEnvValue(server.command) ?? server.command,
			args: (server.args ?? []).map((arg) => expandEnvValue(arg) ?? arg),
			env,
		});
		const client = new ClientMod.Client({ name: "pi-marathon-probe", version: "0.1.0" }, { capabilities: {} });
		try {
			await withTimeout(client.connect(transport), timeoutMs, `connect ${name}`);
			const listed = await withTimeout(client.listTools(), timeoutMs, `listTools ${name}`);
			toolCount += Array.isArray(listed.tools) ? listed.tools.length : 0;
			await client.close().catch(() => undefined);
		} catch (error) {
			await transport.close().catch(() => undefined);
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}
	return { toolCount };
}

/** Gate: spawning is blocked until the human has confirmed readiness; MCP sources must be usable. */
async function ensureKickoff(paths: InvestigationPaths, source?: EvidenceSource): Promise<void> {
	const report = await readReadiness(paths);
	if (!isConfirmed(report)) {
		throw new Error("Investigation not kicked off yet. Run investigation_preflight, resolve any access gaps with the human, then investigation_confirm.");
	}
	if (source && MCP_SOURCE_SET.has(source) && !sourceUsable(report, source)) {
		throw new Error(`Source '${source}' is not available (not ready or skipped at confirmation). Re-run investigation_preflight after granting access, or use a different source.`);
	}
}

export default function marathonInvestigationExtension(pi: ExtensionAPI) {
	pi.registerFlag("marathon-verifiers", {
		description: "Number of independent verifier subagents per claim (quorum). Default: 5.",
		type: "string",
		default: process.env.PI_MARATHON_VERIFIERS ?? String(DEFAULT_VERIFIERS),
	});
	pi.registerFlag("marathon-spawn-concurrency", {
		description: "Max concurrent subagent processes. Default: 3.",
		type: "string",
		default: process.env.PI_MARATHON_SPAWN_CONCURRENCY ?? String(DEFAULT_CONCURRENCY),
	});
	pi.registerFlag("marathon-spawn-timeout", {
		description: "Per-subagent timeout in ms. Default: 300000.",
		type: "string",
		default: process.env.PI_MARATHON_SPAWN_TIMEOUT_MS ?? String(DEFAULT_SPAWN_TIMEOUT_MS),
	});
	pi.registerFlag("marathon-child-pi", {
		description: "Command used to spawn subagent pi processes. Default: pi.",
		type: "string",
		default: process.env.PI_MARATHON_CHILD_PI ?? "pi",
	});
	pi.registerFlag("marathon-superpowers", {
		description: "Path to the pi-superpowers extension; when set, MCP-backed specialists (slack/jira/confluence) spawn with it for tool access.",
		type: "string",
		default: process.env.PI_MARATHON_SUPERPOWERS ?? "",
	});
	pi.registerFlag("marathon-superpowers-config", {
		description: "Path to the superpowers profile config used for MCP readiness checks. Default: $PI_SUPERPOWERS_CONFIG or ~/.pi/agent/superpowers.json.",
		type: "string",
		default: process.env.PI_SUPERPOWERS_CONFIG ?? "",
	});

	function paths(ctx: ExtensionContext): InvestigationPaths {
		return investigationPaths(ctx.cwd, flagString(pi, "marathon-dir", ""));
	}

	pi.registerTool({
		name: "investigation_plan",
		label: "Investigation Plan",
		description: "Decompose a problem into sub-questions and write the investigation brief. Call once at the start of an investigation.",
		promptSnippet: "Write the investigation brief (problem + sub-questions)",
		parameters: Type.Object({
			problem: Type.String({ description: "The problem/question to investigate." }),
			subQuestions: Type.Optional(Type.Array(Type.String(), { description: "Sub-questions to drive specialist gathering." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx);
			await writeBrief(p, params.problem, params.subQuestions ?? []);
			return { content: [{ type: "text", text: `Investigation brief written to ${path.relative(ctx.cwd, p.brief)}.` }], details: { dir: p.dir } };
		},
	});

	pi.registerTool({
		name: "investigation_preflight",
		label: "Investigation Preflight",
		description: "Check whether the evidence sources you intend to use are available BEFORE kicking off the long-running investigation. For MCP-backed sources (slack/jira/confluence) it checks the superpowers config + required env vars and (by default) live-connects to the MCP servers to count tools. Writes readiness.json and clears any prior confirmation. If gaps are reported, ask the human to grant access, then re-run; only investigation_confirm opens the gate.",
		promptSnippet: "Preflight evidence-source/MCP availability before kicking off the investigation",
		promptGuidelines: [
			"Always preflight before spawning. If a source is not ready, ask the human to provide access (set env/config) rather than proceeding silently.",
			"Re-run preflight after the human grants access; spawning stays blocked until investigation_confirm.",
		],
		parameters: Type.Object({
			sources: Type.Array(Type.Union([Type.Literal("slack"), Type.Literal("jira"), Type.Literal("confluence"), Type.Literal("repo")]), { description: "Sources this investigation will use." }),
			live: Type.Optional(Type.Boolean({ description: "Live-connect to MCP servers to confirm tools (default true). Set false for a fast static check." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx);
			await ensureInvestigation(p);
			const configPath = resolveSuperpowersConfigPath(flagString(pi, "marathon-superpowers-config", ""));
			const config = await loadSuperpowersConfig(configPath);
			const live = params.live ?? true;
			const timeoutMs = flagNumber(pi, "marathon-spawn-timeout", DEFAULT_SPAWN_TIMEOUT_MS);
			const requested = [...new Set(params.sources as EvidenceSource[])];

			const sources: SourceReadiness[] = [];
			for (const source of requested) {
				const entry = staticReadiness(config, source);
				// Availability is decided by reaching the MCP, not by env vars: probe whenever the
				// source is structurally configured, regardless of whether referenced env is set.
				if (live && entry.status === "configured" && MCP_SOURCE_SET.has(source) && config) {
					const probe = await probeLiveProfile(config, entry.profile, Math.min(timeoutMs, 30_000));
					if ("error" in probe) {
						const envHint = entry.missingEnv && entry.missingEnv.length > 0 ? ` (note: ${entry.missingEnv.join(", ")} unset — may be required, or your MCP may use CLI/OAuth auth)` : "";
						entry.ready = false;
						entry.status = "connect-failed";
						entry.detail = `live MCP connect failed: ${probe.error}${envHint}`;
					} else if (probe.toolCount === 0) {
						entry.ready = false;
						entry.status = "no-tools";
						entry.detail = "MCP connected but exposed no tools";
					} else {
						entry.ready = true;
						entry.status = "ready";
						entry.toolCount = probe.toolCount;
						entry.detail = `MCP connected, ${probe.toolCount} tool(s)`;
					}
				}
				sources.push(entry);
			}

			const report: ReadinessReport = { updatedAt: new Date().toISOString(), configPath, sources };
			await writeReadiness(p, report);
			const unmet = unmetSources(report);
			const guidance = unmet.length === 0
				? "All requested sources are reachable. Call investigation_confirm to kick off."
				: `Not ready: ${unmet.map((s) => `${s.source} (${s.detail})`).join("; ")}. Ask the human to make each MCP available — add/enable its profile in the MCP config and ensure the server starts (it may authenticate via an already-logged-in CLI, OAuth, or a token, depending on the server). Then re-run investigation_preflight. To proceed without a source, pass it to investigation_confirm's proceedWithout.`;
			return { content: [{ type: "text", text: `${renderReadiness(report)}\n\n${guidance}` }], details: { report, unmet: unmet.map((s) => s.source) } };
		},
	});

	pi.registerTool({
		name: "investigation_confirm",
		label: "Investigation Confirm",
		description: "Confirm access and kick off the long-running investigation. Requires a prior investigation_preflight. Refuses if any source is still not ready unless you explicitly drop it via proceedWithout. Stamps readiness as confirmed; spawning is blocked until this succeeds.",
		promptSnippet: "Confirm source access and open the gate to start spawning specialists",
		promptGuidelines: [
			"Call investigation_confirm only after preflight shows the needed sources ready, or the human explicitly agrees to proceed without a source.",
		],
		parameters: Type.Object({
			proceedWithout: Type.Optional(Type.Array(Type.Union([Type.Literal("slack"), Type.Literal("jira"), Type.Literal("confluence"), Type.Literal("repo")]), { description: "Sources the human agreed to drop; they are marked skipped and won't be used." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx);
			const report = await readReadiness(p);
			if (!report) throw new Error("No readiness record. Run investigation_preflight first.");
			const drop = new Set<EvidenceSource>(params.proceedWithout ?? []);
			for (const entry of report.sources) if (drop.has(entry.source)) entry.skipped = true;
			const unmet = unmetSources(report);
			if (unmet.length > 0) {
				throw new Error(`Cannot kick off: ${unmet.map((s) => `${s.source} (${s.detail})`).join("; ")}. Grant access and re-run investigation_preflight, or pass these to proceedWithout to drop them.`);
			}
			report.confirmedAt = new Date().toISOString();
			report.updatedAt = report.confirmedAt;
			await writeReadiness(p, report);
			const usable = report.sources.filter((s) => s.ready && !s.skipped).map((s) => s.source);
			const skipped = report.sources.filter((s) => s.skipped).map((s) => s.source);
			return {
				content: [{ type: "text", text: `Investigation kicked off. Usable sources: ${usable.join(", ") || "(none)"}${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}.` }],
				details: { confirmedAt: report.confirmedAt, usable, skipped },
			};
		},
	});

	pi.registerTool({
		name: "spawn_specialist",
		label: "Spawn Specialist",
		description: "Spawn an isolated specialist subagent for one evidence source (slack/jira/confluence/repo) with a highly specific brief. The subagent's report is written to reports/<source>.md and its cited claims are appended to the ledger; only a short summary returns to your context.",
		promptSnippet: "Spawn a source specialist subagent; its report goes to disk, not your context",
		promptGuidelines: [
			"Give each specialist a narrow brief tied to one sub-question.",
			"Specialist output never enters your context; read reports/<source>.md only if you must.",
		],
		parameters: Type.Object({
			source: Type.Union([Type.Literal("slack"), Type.Literal("jira"), Type.Literal("confluence"), Type.Literal("repo")], { description: "Evidence source." }),
			subQuestion: Type.String({ description: "The specific question this specialist must answer." }),
			brief: Type.Optional(Type.String({ description: "Extra context/constraints for the specialist." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Override per-subagent timeout in ms." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = paths(ctx);
			const source = params.source as EvidenceSource;
			await ensureKickoff(p, source);
			await ensureInvestigation(p);
			const systemPrompt = await loadSubskill(SOURCE_SUBSKILL[source]);
			const task = [
				`INVESTIGATE (${source}) — answer this sub-question with cited evidence:`,
				params.subQuestion,
				params.brief ? `\nContext:\n${params.brief}` : "",
				"\nProduce a markdown report and END with a <claims> block, one JSON object per line: {\"statement\":\"...\",\"citations\":[\"<source-permalink-or-path:line>\"],\"confidence\":\"low|medium|high\"}.",
			].join("\n");
			const result = await runHeadlessAgent({
				childPi: flagString(pi, "marathon-child-pi", "pi"),
				systemPrompt,
				task,
				extraArgs: specialistExtraArgs(pi, source),
				cwd: ctx.cwd,
				timeoutMs: params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : flagNumber(pi, "marathon-spawn-timeout", DEFAULT_SPAWN_TIMEOUT_MS),
				signal,
			});
			const reportFile = reportFileFor(p, source);
			await mkdir(path.dirname(reportFile), { recursive: true });
			await writeFile(reportFile, `${result.answer || "(specialist returned no report)"}\n`, "utf8");

			const parsed = parseClaimsBlock(result.answer);
			const existing = await readClaims(p.claims);
			let index = existing.length;
			for (const claim of parsed) {
				const record: Claim = {
					id: makeClaimId(index++),
					source,
					statement: claim.statement,
					citations: claim.citations,
					reportFile: path.relative(ctx.cwd, reportFile),
					createdBy: `specialist:${source}`,
					createdAt: new Date().toISOString(),
				};
				await appendClaim(p.claims, record);
			}
			const status = result.timedOut ? "timed out" : result.exitCode === 0 ? "ok" : `exit ${result.exitCode}`;
			return {
				content: [{ type: "text", text: `specialist ${source} ${status}: ${parsed.length} claim(s) → ${path.relative(ctx.cwd, reportFile)}` }],
				details: { source, reportFile, claimCount: parsed.length, exitCode: result.exitCode, timedOut: result.timedOut },
			};
		},
	});

	pi.registerTool({
		name: "claim_add",
		label: "Claim Add",
		description: "Manually add a cited claim to the ledger (when not produced by a specialist's <claims> block).",
		promptSnippet: "Add a cited claim to the investigation ledger",
		parameters: Type.Object({
			source: Type.Union([Type.Literal("slack"), Type.Literal("jira"), Type.Literal("confluence"), Type.Literal("repo"), Type.Literal("other")]),
			statement: Type.String({ description: "The atomic, checkable claim." }),
			citations: Type.Array(Type.String(), { description: "Primary-source citations supporting the claim." }),
			key: Type.Optional(Type.Boolean({ description: "Mark as a key claim (verified first)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx);
			const existing = await readClaims(p.claims);
			const claim: Claim = {
				id: makeClaimId(existing.length),
				source: params.source as EvidenceSource,
				statement: params.statement,
				citations: params.citations,
				key: params.key,
				createdBy: "orchestrator",
				createdAt: new Date().toISOString(),
			};
			await appendClaim(p.claims, claim);
			return { content: [{ type: "text", text: `Added claim ${claim.id}.` }], details: { claim } };
		},
	});

	pi.registerTool({
		name: "spawn_verifier",
		label: "Spawn Verifier",
		description: "Spawn N independent verifier subagents for one claim. Each runs in isolation, re-fetches the cited primary source, and returns a structured verdict. Verdicts are appended to the ledger; only the tally and computed status return to your context. A claim is confirmed only when grounded supports reach the quorum.",
		promptSnippet: "Independently verify a claim with a quorum of isolated verifier subagents",
		promptGuidelines: [
			"Verify key claims (those feeding conclusions) first; verification is the expensive step.",
			"A claim is confirmed only when enough independent verifiers support it WITH a re-fetched citation.",
		],
		parameters: Type.Object({
			claimId: Type.String({ description: "Id of the claim to verify (from the ledger)." }),
			n: Type.Optional(Type.Number({ description: "Number of independent verifiers. Default: the configured quorum." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Override per-verifier timeout in ms." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = paths(ctx);
			const claims = await readClaims(p.claims);
			const claim = claims.find((entry) => entry.id === params.claimId);
			if (!claim) throw new Error(`Unknown claim id: ${params.claimId}`);
			await ensureKickoff(p, claim.source);
			const quorum = flagNumber(pi, "marathon-verifiers", DEFAULT_VERIFIERS);
			const n = Math.max(1, Math.trunc(params.n && params.n > 0 ? params.n : quorum));
			const systemPrompt = await loadSubskill("claim-verifier");
			const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : flagNumber(pi, "marathon-spawn-timeout", DEFAULT_SPAWN_TIMEOUT_MS);
			const childPi = flagString(pi, "marathon-child-pi", "pi");
			const task = [
				`VERIFY CLAIM independently. Do not assume it is true.`,
				`Claim: ${claim.statement}`,
				`Source: ${claim.source}`,
				`Cited evidence to re-fetch and check: ${claim.citations.length > 0 ? claim.citations.join(", ") : "(none provided)"}`,
				`Re-open the primary source yourself and judge. END with a <verdict> JSON block: {"verdict":"supported|partial|refuted|unverifiable","citation":"<what you re-fetched>","quote":"<exact quote>","confidence":"low|medium|high"}.`,
			].join("\n");
			const extraArgs = specialistExtraArgs(pi, claim.source);

			const verifierIds = Array.from({ length: n }, (_unused, index) => `v${Date.now().toString(36)}-${index}`);
			let supports = 0;
			let refutes = 0;
			let parsedCount = 0;
			await runPool(verifierIds, flagNumber(pi, "marathon-spawn-concurrency", DEFAULT_CONCURRENCY), async (verifierId) => {
				const result = await runHeadlessAgent({ childPi, systemPrompt, task, extraArgs, cwd: ctx.cwd, timeoutMs, signal });
				const parsed = parseVerdictBlock(result.answer);
				if (!parsed) {
					await appendVerdict(p.verdicts, { claimId: claim.id, verifier: verifierId, verdict: "unverifiable", createdAt: new Date().toISOString() });
					return;
				}
				parsedCount++;
				if (parsed.verdict === "supported" && parsed.citation) supports++;
				if (parsed.verdict === "refuted") refutes++;
				await appendVerdict(p.verdicts, {
					claimId: claim.id,
					verifier: verifierId,
					verdict: parsed.verdict,
					citation: parsed.citation,
					quote: parsed.quote,
					confidence: parsed.confidence,
					createdAt: new Date().toISOString(),
				});
			});

			const allVerdicts = await readVerdicts(p.verdicts);
			const evaluation = evaluateClaim(claim.id, allVerdicts, quorum);
			return {
				content: [{ type: "text", text: `claim ${claim.id}: ${evaluation.status} (grounded supports ${evaluation.groundedSupports}/${quorum}, refutes ${evaluation.refutes}, parsed ${parsedCount}/${n})` }],
				details: { claimId: claim.id, status: evaluation.status, evaluation, ran: n, supports, refutes },
			};
		},
	});

	pi.registerTool({
		name: "report_compile",
		label: "Report Compile",
		description: "Compile index.md, report.md (confirmed findings), and contested.md from the claim/verdict ledgers, and report the agreement metric (confirmed/total).",
		promptSnippet: "Compile the indexed investigation report and agreement metric",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const p = paths(ctx);
			const quorum = flagNumber(pi, "marathon-verifiers", DEFAULT_VERIFIERS);
			const result = await compileReports(p, quorum);
			const text = [
				`Compiled ${result.totalClaims} claim(s). agreement ${(result.agreement * 100).toFixed(0)}%.`,
				`confirmed:${result.counts.confirmed} contested:${result.counts.contested} refuted:${result.counts.refuted} unverifiable:${result.counts.unverifiable} pending:${result.counts.pending}`,
				`Outputs: ${path.relative(ctx.cwd, p.index)}, ${path.relative(ctx.cwd, p.report)}, ${path.relative(ctx.cwd, p.contested)}`,
			].join("\n");
			return { content: [{ type: "text", text }], details: { ...result } };
		},
	});

	pi.registerTool({
		name: "investigation_status",
		label: "Investigation Status",
		description: "Recompile and show the current investigation agreement and claim status breakdown.",
		promptSnippet: "Show investigation progress (agreement, claim status)",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const p = paths(ctx);
			const quorum = flagNumber(pi, "marathon-verifiers", DEFAULT_VERIFIERS);
			const result = await compileReports(p, quorum);
			return {
				content: [{ type: "text", text: `agreement ${(result.agreement * 100).toFixed(0)}% — confirmed:${result.counts.confirmed} contested:${result.counts.contested} refuted:${result.counts.refuted} unverifiable:${result.counts.unverifiable} pending:${result.counts.pending} (of ${result.totalClaims})` }],
				details: { ...result },
			};
		},
	});
}
