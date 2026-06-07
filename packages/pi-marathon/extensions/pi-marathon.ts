import { spawn } from "node:child_process";
import { closeSync, createReadStream, existsSync, openSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { buildCompactionInstructions } from "../src/compaction-summary.ts";
import { canAutoTick, nextEmptyTicks, shouldDisarm } from "../src/loop.ts";
import {
	appendLog,
	checkTermination,
	initMission,
	isPaused,
	isStopRequested,
	marathonPaths,
	readState,
	writeBest,
	writeState,
	writeSummary,
	type MarathonPaths,
	type MissionState,
} from "../src/mission.ts";
import {
	appendResult,
	formatMetric,
	isImprovement,
	readResults,
	type ExperimentStatus,
} from "../src/results.ts";
import { renderStatus } from "../src/status.ts";

const DEFAULT_SOFT_THRESHOLD = 0.7;
const DEFAULT_TICK_DELAY_MS = 2000;
const DEFAULT_MAX_EMPTY_TICKS = 3;
const DEFAULT_RUN_TIMEOUT_MS = 900_000;
const RUN_OUTPUT_MAX_LINES = 120;
const RUN_OUTPUT_MAX_CHARS = 4000;
const TICK_PROMPT = "continue";

function flagString(pi: ExtensionAPI, name: string, fallback: string): string {
	const value = pi.getFlag(name);
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function flagBool(pi: ExtensionAPI, name: string, fallback: boolean): boolean {
	const value = pi.getFlag(name);
	return typeof value === "boolean" ? value : fallback;
}

function flagNumber(pi: ExtensionAPI, name: string, fallback: number): number {
	const value = Number(flagString(pi, name, String(fallback)));
	return Number.isFinite(value) ? value : fallback;
}

/** pi reports context usage as a percentage; normalize to a 0..1 fraction regardless of scale. */
function normalizePercent(percent: number | null | undefined): number | null {
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
	return percent > 1.5 ? percent / 100 : percent;
}

export default function piMarathonExtension(pi: ExtensionAPI) {
	pi.registerFlag("marathon-dir", {
		description: "Directory for marathon mission state. Defaults to <cwd>/.marathon (or $PI_MARATHON_DIR).",
		type: "string",
		default: process.env.PI_MARATHON_DIR ?? "",
	});
	pi.registerFlag("marathon-autoloop", {
		description: "Re-trigger the agent after each turn so the mission loops without a human. Default: true.",
		type: "boolean",
		default: process.env.PI_MARATHON_AUTOLOOP === undefined ? true : process.env.PI_MARATHON_AUTOLOOP !== "0",
	});
	pi.registerFlag("marathon-soft-threshold", {
		description: "Context-usage fraction (0..1) at which the agent is nudged to wrap up before compaction. Default: 0.7.",
		type: "string",
		default: process.env.PI_MARATHON_SOFT_THRESHOLD ?? String(DEFAULT_SOFT_THRESHOLD),
	});
	pi.registerFlag("marathon-tick-delay", {
		description: "Delay in ms before the auto-loop re-triggers a turn. Default: 2000.",
		type: "string",
		default: process.env.PI_MARATHON_TICK_DELAY_MS ?? String(DEFAULT_TICK_DELAY_MS),
	});

	let currentCtx: ExtensionContext | undefined;
	let loopArmed = true;
	let tickScheduled = false;
	let lastSeenIteration = 0;
	let emptyTicks = 0;
	let wrapNudgeIteration = -1;

	function readPaths(ctx: ExtensionContext): MarathonPaths {
		return marathonPaths(ctx.cwd, flagString(pi, "marathon-dir", ""));
	}

	function updateWidget(ctx: ExtensionContext, state: MissionState | undefined, percent?: number | null): void {
		if (!state) {
			ctx.ui.setStatus("marathon", undefined);
			return;
		}
		const frac = normalizePercent(percent);
		const ctxLabel = frac === null ? "" : ` · ctx ${Math.round(frac * 100)}%`;
		ctx.ui.setStatus("marathon", `marathon: #${state.iteration} ${state.status}${ctxLabel}`);
	}

	function scheduleTick(ctx: ExtensionContext, delayMs: number): void {
		if (tickScheduled) return;
		tickScheduled = true;
		const timer = setTimeout(async () => {
			tickScheduled = false;
			// Re-read state and sentinels at fire time so a pause/stop (including from the CLI in
			// another process) landing during the delay cannot leak one extra turn.
			const paths = readPaths(ctx);
			const state = await readState(paths);
			const gate = {
				status: state?.status ?? "stopped",
				loopArmed,
				paused: isPaused(paths),
				stopRequested: isStopRequested(paths),
				idle: ctx.isIdle(),
				hasPending: ctx.hasPendingMessages(),
			};
			if (!state || !canAutoTick(gate)) return;
			pi.sendMessage(
				{ customType: "marathon.tick", content: TICK_PROMPT, display: false },
				{ triggerTurn: true },
			);
		}, delayMs);
		timer.unref?.();
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		loopArmed = flagBool(pi, "marathon-autoloop", true);
		const state = await readState(readPaths(ctx));
		if (state) {
			lastSeenIteration = state.iteration;
			updateWidget(ctx, state, ctx.getContextUsage()?.percent ?? null);
			if (ctx.hasUI) ctx.ui.notify(`Marathon ${state.status}: ${state.goal} (iteration ${state.iteration})`, "info");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = await readState(readPaths(ctx));
		if (!state) return;
		const preamble = [
			"You are running inside a pi-marathon long-running research session.",
			`Mission: ${state.goal}. Metric: ${state.metricName} (${state.direction}=better). Status: ${state.status}.`,
			"Follow the marathon skill: THINK, run ONE experiment via marathon_run (output is redirected — never flood context), record it via marathon_record, keep or discard, then continue. Do NOT ask the human whether to continue.",
			"Treat .marathon/ on disk as the source of truth; re-read it after any compaction.",
		].join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${preamble}` };
	});

	pi.on("turn_end", async (_event, ctx) => {
		currentCtx = ctx;
		const paths = readPaths(ctx);
		const state = await readState(paths);
		if (!state) return;
		const usage = ctx.getContextUsage();
		updateWidget(ctx, state, usage?.percent ?? null);
		if (state.status !== "running") return;
		const frac = normalizePercent(usage?.percent ?? null);
		const soft = flagNumber(pi, "marathon-soft-threshold", DEFAULT_SOFT_THRESHOLD);
		if (frac !== null && frac >= soft && wrapNudgeIteration !== state.iteration) {
			wrapNudgeIteration = state.iteration;
			pi.sendMessage(
				{
					customType: "marathon.wrap",
					content: `Context at ${Math.round(frac * 100)}%. Bring the current experiment to a clean git commit and call marathon_record now. Do not begin a new experiment until the context window has compacted.`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		const paths = readPaths(ctx);
		const state = await readState(paths);
		if (!state) return;
		const rows = await readResults(paths.results);
		pi.sendMessage(
			{ customType: "marathon.state", content: buildCompactionInstructions(state, rows, paths), display: true },
			{ triggerTurn: false },
		);
	});

	pi.on("agent_end", async (_event, ctx) => {
		currentCtx = ctx;
		if (!loopArmed) return;
		const paths = readPaths(ctx);
		const state = await readState(paths);
		if (!state || state.status !== "running") return;
		if (isStopRequested(paths)) return;
		if (isPaused(paths)) {
			updateWidget(ctx, state, ctx.getContextUsage()?.percent ?? null);
			return;
		}
		emptyTicks = nextEmptyTicks(emptyTicks, lastSeenIteration, state.iteration);
		lastSeenIteration = state.iteration;
		if (shouldDisarm(emptyTicks, DEFAULT_MAX_EMPTY_TICKS)) {
			loopArmed = false;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Marathon auto-loop disarmed after ${emptyTicks} turns with no recorded experiment. Inspect the session and run /marathon-resume to continue.`,
					"warning",
				);
			}
			return;
		}
		scheduleTick(ctx, flagNumber(pi, "marathon-tick-delay", DEFAULT_TICK_DELAY_MS));
	});

	pi.on("session_shutdown", async () => {
		loopArmed = false;
		tickScheduled = false;
	});

	const loop: LoopControl = {
		rearm: () => {
			loopArmed = flagBool(pi, "marathon-autoloop", true);
			emptyTicks = 0;
		},
		disarm: () => {
			loopArmed = false;
		},
	};
	registerTools(pi, readPaths, loop);
	registerCommands(pi, readPaths, loop);
}

interface LoopControl {
	rearm: () => void;
	disarm: () => void;
}

function registerTools(pi: ExtensionAPI, readPaths: (ctx: ExtensionContext) => MarathonPaths, loop: LoopControl): void {
	pi.registerTool({
		name: "marathon_configure",
		label: "Marathon Configure",
		description: "Initialize a long-running marathon mission in .marathon/: goal, metric, direction, and optional termination conditions. Call once after Discovery, before the experiment loop.",
		promptSnippet: "Initialize a pi-marathon mission (goal, metric, termination conditions)",
		promptGuidelines: [
			"Call marathon_configure exactly once at the start of a mission, after agreeing the goal and metric with the user.",
			"direction is 'lower' when a smaller metric is better (latency, loss) and 'higher' when larger is better (accuracy).",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "What the mission optimizes, in one sentence." }),
			metricName: Type.String({ description: "Name of the primary metric, e.g. val_bpb, p99_ms, accuracy." }),
			direction: Type.Union([Type.Literal("lower"), Type.Literal("higher")], { description: "Whether lower or higher metric values are better." }),
			target: Type.Optional(Type.Number({ description: "Stop once best reaches this value." })),
			maxIterations: Type.Optional(Type.Number({ description: "Stop after this many recorded experiments." })),
			maxPlateau: Type.Optional(Type.Number({ description: "Stop when best is unchanged for this many experiments." })),
			branch: Type.Optional(Type.String({ description: "Git branch the mission runs on (informational)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const paths = readPaths(ctx);
			const existing = await readState(paths);
			if (existing && existing.status === "running" && existing.iteration > 0) {
				throw new Error(`A running marathon mission already exists in ${paths.dir} (iteration ${existing.iteration}). Stop it with marathon_stop before reconfiguring.`);
			}
			const state = await initMission(paths, {
				goal: params.goal,
				metricName: params.metricName,
				direction: params.direction,
				target: params.target,
				maxIterations: params.maxIterations,
				maxPlateau: params.maxPlateau,
				branch: params.branch,
			});
			loop.rearm();
			return {
				content: [{ type: "text", text: `Marathon configured in ${paths.dir}.\n\n${renderStatus(state, [])}` }],
				details: { dir: paths.dir, state },
			};
		},
	});

	pi.registerTool({
		name: "marathon_run",
		label: "Marathon Run",
		description: "Run a shell command for one experiment with stdout+stderr redirected to a log file. Returns ONLY the lines matching `extract` (or the last `tail` lines) so command output never floods the context window. Use this for every build/train/measure command.",
		promptSnippet: "Run an experiment command with output redirected; return only the extracted metric lines",
		promptGuidelines: [
			"Always run experiments through marathon_run, never via raw bash, so training/build output stays out of context.",
			"Pass `extract` with a regex for the metric line(s), e.g. '^val_bpb:' — return as little as possible.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run (executed via bash -lc)." }),
			extract: Type.Optional(Type.String({ description: "Regex applied per output line; only matching lines are returned. Omit to return the last `tail` lines." })),
			tail: Type.Optional(Type.Number({ description: "Lines to return when `extract` is not given. Default 20." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Hard timeout in ms; the process is killed on overrun. Default 900000." })),
			label: Type.Optional(Type.String({ description: "Short label used in the run log filename." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const paths = readPaths(ctx);
			await mkdir(paths.runs, { recursive: true });
			const stamp = Date.now().toString(36);
			const slug = params.label ? `-${params.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32)}` : "";
			const logPath = path.join(paths.runs, `${stamp}${slug}.log`);
			const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_RUN_TIMEOUT_MS;
			const result = await runRedirected(params.command, logPath, timeoutMs, signal);
			const extracted = await extractFromLog(logPath, params.extract, params.tail ?? 20);
			const status = result.timedOut
				? `TIMED OUT after ${(timeoutMs / 1000).toFixed(0)}s`
				: result.killedSignal
					? `KILLED (${result.killedSignal})`
					: result.exitCode === 0
						? "ok"
						: `exit ${result.exitCode}`;
			const header = `run ${status} in ${(result.durationMs / 1000).toFixed(1)}s — log: ${path.relative(ctx.cwd, logPath)}`;
			const text = `${header}\n\n${extracted || "(no matching output — run tail or read the log)"}`;
			return {
				content: [{ type: "text", text }],
				details: { exitCode: result.exitCode, timedOut: result.timedOut, killedSignal: result.killedSignal, durationMs: result.durationMs, logPath, command: params.command },
			};
		},
	});

	pi.registerTool({
		name: "marathon_record",
		label: "Marathon Record",
		description: "Record one experiment to results.tsv, update mission state (best, plateau), update best.md, and report whether a termination condition is met. Call once per experiment.",
		promptSnippet: "Record an experiment result and update marathon mission state",
		promptGuidelines: [
			"Call marathon_record exactly once per experiment, after reading its metric.",
			"Use status 'baseline' for the first run, 'keep' if the metric improved (advance the branch), 'discard' if not (git reset --hard), 'crash' if it failed to run.",
		],
		parameters: Type.Object({
			n: Type.Number({ description: "Experiment number (0 for baseline, then 1, 2, …)." }),
			commit: Type.String({ description: "Short git commit hash for this experiment." }),
			metric: Type.Number({ description: "Primary metric value (use 0 for crashes)." }),
			status: Type.Union([Type.Literal("baseline"), Type.Literal("keep"), Type.Literal("discard"), Type.Literal("crash")], { description: "Outcome of the experiment." }),
			description: Type.String({ description: "Short description of what the experiment tried." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const paths = readPaths(ctx);
			const state = await readState(paths);
			if (!state) throw new Error(`No marathon mission configured in ${paths.dir}. Call marathon_configure first.`);
			const status = params.status as ExperimentStatus;
			await appendResult(paths.results, { n: params.n, commit: params.commit, metric: params.metric, status, description: params.description });

			const considerForBest = status === "keep" || status === "baseline";
			const improved = considerForBest && isImprovement(state.direction, params.metric, state.best?.metric);
			const next: MissionState = { ...state, iteration: state.iteration + 1, lastMetric: params.metric, updatedAt: new Date().toISOString() };
			if (improved) {
				next.best = { n: params.n, metric: params.metric, commit: params.commit, description: params.description };
				next.plateau = 0;
			} else if (status !== "baseline") {
				next.plateau = state.plateau + 1;
			}
			const termination = checkTermination(next);
			if (termination.done) {
				next.status = "done";
				next.terminationReason = termination.reason;
			}
			await writeState(paths, next);
			if (improved) await writeBest(paths, next);
			await appendLog(paths, "RUN", `#${params.n} ${status} ${state.metricName}=${formatMetric(params.metric)} — ${params.description}`);
			if (termination.done) await writeSummary(paths, next, await readResults(paths.results));
			loop.rearm();

			const hint = termination.done
				? `TERMINATION: ${termination.reason}. Call marathon_stop, then stop the loop.`
				: improved
					? `New best ${formatMetric(params.metric)} at #${params.n}. Keep iterating.`
					: `Recorded #${params.n} (${status}). plateau=${next.plateau}. Keep iterating.`;
			return {
				content: [{ type: "text", text: hint }],
				details: { improved, terminate: termination.done, reason: termination.reason, best: next.best, plateau: next.plateau, iteration: next.iteration },
			};
		},
	});

	pi.registerTool({
		name: "marathon_log",
		label: "Marathon Log",
		description: "Append a THINK/RUN/REFLECT/NOTE entry to the mission log. THINK before each experiment is mandatory.",
		promptSnippet: "Append a THINK/REFLECT note to the marathon log",
		parameters: Type.Object({
			phase: Type.Union([Type.Literal("THINK"), Type.Literal("RUN"), Type.Literal("REFLECT"), Type.Literal("NOTE")]),
			text: Type.String({ description: "The note to append." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const paths = readPaths(ctx);
			await appendLog(paths, params.phase, params.text);
			return { content: [{ type: "text", text: `Logged ${params.phase}.` }], details: { phase: params.phase } };
		},
	});

	pi.registerTool({
		name: "marathon_status",
		label: "Marathon Status",
		description: "Show current marathon mission progress: metric, baseline, best, recent experiments.",
		promptSnippet: "Show marathon mission progress",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const paths = readPaths(ctx);
			const state = await readState(paths);
			if (!state) return { content: [{ type: "text", text: "No marathon mission configured." }], details: { configured: false } };
			const rows = await readResults(paths.results);
			const percent = normalizePercent(ctx.getContextUsage()?.percent ?? null);
			return { content: [{ type: "text", text: renderStatus(state, rows, { contextPercent: percent }) }], details: { state, rows: rows.length } };
		},
	});

	pi.registerTool({
		name: "marathon_stop",
		label: "Marathon Stop",
		description: "End the mission: write summary.md, mark the mission stopped, and stop the auto-loop. Call when a termination condition is met or the user asks to stop.",
		promptSnippet: "Stop the marathon mission and write a summary",
		parameters: Type.Object({
			reason: Type.Optional(Type.String({ description: "Why the mission is stopping." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const paths = readPaths(ctx);
			const state = await readState(paths);
			if (!state) return { content: [{ type: "text", text: "No marathon mission to stop." }], details: { stopped: false } };
			const next: MissionState = { ...state, status: state.status === "done" ? "done" : "stopped", terminationReason: params.reason ?? state.terminationReason };
			await writeState(paths, next);
			await writeSummary(paths, next, await readResults(paths.results));
			await writeFile(paths.stop, `${new Date().toISOString()} ${params.reason ?? "stopped"}\n`, "utf8");
			loop.disarm();
			return { content: [{ type: "text", text: `Marathon stopped${params.reason ? `: ${params.reason}` : ""}. Summary written to ${path.relative(ctx.cwd, paths.summary)}.` }], details: { stopped: true, summary: paths.summary } };
		},
	});
}

function registerCommands(
	pi: ExtensionAPI,
	readPaths: (ctx: ExtensionContext) => MarathonPaths,
	loop: LoopControl,
): void {
	pi.registerCommand("marathon-status", {
		description: "Show marathon mission progress",
		handler: async (_args, ctx) => {
			const paths = readPaths(ctx);
			const state = await readState(paths);
			if (!state) {
				ctx.ui.notify("No marathon mission configured in this directory.", "info");
				return;
			}
			const rows = await readResults(paths.results);
			const percent = normalizePercent(ctx.getContextUsage()?.percent ?? null);
			ctx.ui.notify(renderStatus(state, rows, { contextPercent: percent }), "info");
		},
	});

	pi.registerCommand("marathon-pause", {
		description: "Pause the marathon auto-loop without ending the mission",
		handler: async (_args, ctx) => {
			const paths = readPaths(ctx);
			await mkdir(paths.dir, { recursive: true });
			await writeFile(paths.pause, `${new Date().toISOString()}\n`, "utf8");
			loop.disarm();
			ctx.ui.notify("Marathon paused. Run /marathon-resume to continue the loop.", "info");
		},
	});

	pi.registerCommand("marathon-resume", {
		description: "Resume the marathon auto-loop",
		handler: async (_args, ctx) => {
			const paths = readPaths(ctx);
			await rm(paths.pause, { force: true });
			loop.rearm();
			ctx.ui.notify("Marathon resumed.", "info");
		},
	});

	pi.registerCommand("marathon-stop", {
		description: "Stop the marathon mission and write a summary",
		handler: async (args, ctx) => {
			const paths = readPaths(ctx);
			const state = await readState(paths);
			if (!state) {
				ctx.ui.notify("No marathon mission to stop.", "info");
				return;
			}
			const reason = args.trim() || "stopped by user";
			const next: MissionState = { ...state, status: state.status === "done" ? "done" : "stopped", terminationReason: reason };
			await writeState(paths, next);
			await writeSummary(paths, next, await readResults(paths.results));
			await writeFile(paths.stop, `${new Date().toISOString()} ${reason}\n`, "utf8");
			loop.disarm();
			ctx.ui.notify(`Marathon stopped: ${reason}. Summary at ${path.relative(ctx.cwd, paths.summary)}.`, "info");
		},
	});
}

interface RunResult {
	exitCode: number;
	timedOut: boolean;
	durationMs: number;
	killedSignal: NodeJS.Signals | null;
}

function runRedirected(command: string, logPath: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<RunResult> {
	return new Promise<RunResult>((resolve, reject) => {
		const start = Date.now();
		let fd: number;
		try {
			fd = openSync(logPath, "a");
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const child = spawn("bash", ["-lc", command], { stdio: ["ignore", fd, fd] });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
		}, timeoutMs);
		timer.unref?.();
		const onAbort = () => child.kill("SIGTERM");
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			try {
				closeSync(fd);
			} catch {
				// already closed
			}
		};
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", (code, killedSignal) => {
			cleanup();
			const exitCode = code ?? (killedSignal ? -1 : 0);
			resolve({ exitCode, timedOut, durationMs: Date.now() - start, killedSignal: killedSignal ?? null });
		});
	});
}

/**
 * Stream the run log line-by-line so a multi-GB training log never gets buffered into memory (and
 * therefore never into context). With `extract`, collect matching lines and stop early at the cap;
 * otherwise keep only the last `tail` lines in a bounded ring buffer.
 */
async function extractFromLog(logPath: string, extract: string | undefined, tail: number): Promise<string> {
	if (!existsSync(logPath)) return "";
	let regex: RegExp | undefined;
	if (extract && extract.length > 0) {
		try {
			regex = new RegExp(extract);
		} catch {
			return "";
		}
	}
	const tailCount = Math.max(1, tail);
	const matched: string[] = [];
	const ring: string[] = [];
	let truncated = false;
	try {
		const rl = createInterface({ input: createReadStream(logPath, { encoding: "utf8" }), crlfDelay: Infinity });
		for await (const line of rl) {
			if (regex) {
				if (!regex.test(line)) continue;
				matched.push(line);
				if (matched.length >= RUN_OUTPUT_MAX_LINES) {
					truncated = true;
					break;
				}
			} else if (line.length > 0) {
				ring.push(line);
				if (ring.length > tailCount) ring.shift();
			}
		}
		rl.close();
	} catch {
		return "";
	}
	const picked = regex ? matched : ring;
	if (truncated) picked.push("… (more matching lines omitted; see log)");
	let out = picked.join("\n");
	if (out.length > RUN_OUTPUT_MAX_CHARS) out = `${out.slice(0, RUN_OUTPUT_MAX_CHARS)}\n… (truncated; see log file)`;
	return out;
}
