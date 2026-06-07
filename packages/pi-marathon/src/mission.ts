import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	ensureResultsFile,
	formatMetric,
	type ExperimentRow,
} from "./results.ts";

export const STATE_VERSION = "pi-marathon-state/v1" as const;
export const DEFAULT_DIR_NAME = ".marathon";

export type MetricDirection = "lower" | "higher";
export type MissionStatus = "running" | "paused" | "stopped" | "done";
export type LogPhase = "THINK" | "RUN" | "REFLECT" | "NOTE";

export interface BestRecord {
	n: number;
	metric: number;
	commit?: string;
	description?: string;
}

export interface MissionConfig {
	goal: string;
	metricName: string;
	direction: MetricDirection;
	/** Stop when best reaches this value (optional). */
	target?: number;
	/** Stop after this many recorded experiments (optional). */
	maxIterations?: number;
	/** Stop when best is unchanged for this many experiments (optional). */
	maxPlateau?: number;
	/** Git branch the mission runs on (informational). */
	branch?: string;
}

export interface MissionState extends MissionConfig {
	apiVersion: typeof STATE_VERSION;
	status: MissionStatus;
	createdAt: string;
	updatedAt: string;
	/** Total recorded experiments (monotonic; used by the loop driver to detect progress). */
	iteration: number;
	/** Recorded experiments since `best` last improved. */
	plateau: number;
	best?: BestRecord;
	lastMetric?: number;
	terminationReason?: string;
}

export interface MarathonPaths {
	root: string;
	dir: string;
	config: string;
	state: string;
	results: string;
	log: string;
	best: string;
	summary: string;
	pause: string;
	stop: string;
	runs: string;
}

export function resolveMarathonDir(cwd: string, override?: string): string {
	const fromEnv = override && override.length > 0 ? override : process.env.PI_MARATHON_DIR;
	if (fromEnv && fromEnv.length > 0) return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(cwd, fromEnv);
	return path.join(cwd, DEFAULT_DIR_NAME);
}

export function marathonPaths(cwd: string, override?: string): MarathonPaths {
	const dir = resolveMarathonDir(cwd, override);
	return {
		root: cwd,
		dir,
		config: path.join(dir, "config.md"),
		state: path.join(dir, "state.json"),
		results: path.join(dir, "results.tsv"),
		log: path.join(dir, "log.md"),
		best: path.join(dir, "best.md"),
		summary: path.join(dir, "summary.md"),
		pause: path.join(dir, "pause"),
		stop: path.join(dir, "stop"),
		runs: path.join(dir, "runs"),
	};
}

export function createState(config: MissionConfig, now = new Date()): MissionState {
	const iso = now.toISOString();
	return {
		apiVersion: STATE_VERSION,
		goal: config.goal,
		metricName: config.metricName,
		direction: config.direction,
		target: config.target,
		maxIterations: config.maxIterations,
		maxPlateau: config.maxPlateau,
		branch: config.branch,
		status: "running",
		createdAt: iso,
		updatedAt: iso,
		iteration: 0,
		plateau: 0,
	};
}

export async function readState(paths: MarathonPaths): Promise<MissionState | undefined> {
	if (!existsSync(paths.state)) return undefined;
	const text = await readFile(paths.state, "utf8");
	const parsed = JSON.parse(text) as MissionState;
	if (parsed.apiVersion !== STATE_VERSION) {
		throw new Error(`Unsupported pi-marathon state apiVersion: ${parsed.apiVersion}`);
	}
	return parsed;
}

export async function writeState(paths: MarathonPaths, state: MissionState): Promise<void> {
	await mkdir(paths.dir, { recursive: true });
	const next: MissionState = { ...state, updatedAt: new Date().toISOString() };
	await writeFile(paths.state, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/** Create `.marathon/` with a fresh mission: state.json, config.md, results header, runs/ dir. */
export async function initMission(paths: MarathonPaths, config: MissionConfig): Promise<MissionState> {
	await mkdir(paths.runs, { recursive: true });
	await ensureGitignore(paths);
	const state = createState(config);
	await writeState(paths, state);
	await writeConfigMd(paths, state);
	await ensureResultsFile(paths.results);
	if (!existsSync(paths.log)) {
		await writeFile(paths.log, `# marathon log: ${config.goal}\n`, "utf8");
	}
	return state;
}

/**
 * Keep the whole mission directory untracked. The agent commits experiments and runs
 * `git reset --hard` on discards; a staged `.marathon/` would let a reset silently revert the
 * results/state/log ledger that the mission relies on as its memory.
 */
export async function ensureGitignore(paths: MarathonPaths): Promise<void> {
	const gitignore = path.join(paths.dir, ".gitignore");
	if (existsSync(gitignore)) return;
	await mkdir(paths.dir, { recursive: true });
	await writeFile(gitignore, "*\n", "utf8");
}

export function isPaused(paths: MarathonPaths): boolean {
	return existsSync(paths.pause);
}

export function isStopRequested(paths: MarathonPaths): boolean {
	return existsSync(paths.stop);
}

export async function appendLog(paths: MarathonPaths, phase: LogPhase, text: string): Promise<void> {
	await mkdir(paths.dir, { recursive: true });
	const stamp = new Date().toISOString();
	await appendFile(paths.log, `\n## ${phase} — ${stamp}\n${text.trim()}\n`, "utf8");
}

export async function writeConfigMd(paths: MarathonPaths, state: MissionState): Promise<void> {
	await mkdir(paths.dir, { recursive: true });
	const lines = [
		`# marathon config`,
		"",
		`- goal: ${state.goal}`,
		`- metric: ${state.metricName} (${state.direction}=better)`,
		`- target: ${state.target ?? "(run until stopped)"}`,
		`- max iterations: ${state.maxIterations ?? "(unbounded)"}`,
		`- max plateau: ${state.maxPlateau ?? "(unbounded)"}`,
		`- branch: ${state.branch ?? "(current)"}`,
		`- created: ${state.createdAt}`,
		"",
	];
	await writeFile(paths.config, lines.join("\n"), "utf8");
}

export async function writeBest(paths: MarathonPaths, state: MissionState): Promise<void> {
	if (!state.best) return;
	await mkdir(paths.dir, { recursive: true });
	const lines = [
		`# best so far`,
		"",
		`- metric: ${state.metricName} = ${formatMetric(state.best.metric)} (${state.direction}=better)`,
		`- experiment: #${state.best.n}`,
		`- commit: ${state.best.commit ?? "(none)"}`,
		`- description: ${state.best.description ?? "(none)"}`,
		"",
		`Reproduce by checking out the commit above on branch ${state.branch ?? "(current)"}.`,
		"",
	];
	await writeFile(paths.best, lines.join("\n"), "utf8");
}

export async function writeSummary(paths: MarathonPaths, state: MissionState, rows: ExperimentRow[]): Promise<void> {
	await mkdir(paths.dir, { recursive: true });
	const keeps = rows.filter((row) => row.status === "keep").length;
	const discards = rows.filter((row) => row.status === "discard").length;
	const crashes = rows.filter((row) => row.status === "crash").length;
	const baseline = rows.find((row) => row.status === "baseline");
	const lines = [
		`# marathon summary`,
		"",
		`- goal: ${state.goal}`,
		`- status: ${state.status}${state.terminationReason ? ` (${state.terminationReason})` : ""}`,
		`- metric: ${state.metricName} (${state.direction}=better)`,
		baseline ? `- baseline: ${formatMetric(baseline.metric)}` : `- baseline: (none recorded)`,
		state.best ? `- best: ${formatMetric(state.best.metric)} (#${state.best.n}) — ${state.best.description ?? ""}` : `- best: (none)`,
		`- experiments: ${rows.length} (keeps ${keeps}, discards ${discards}, crashes ${crashes})`,
		"",
	];
	await writeFile(paths.summary, lines.join("\n"), "utf8");
}

export interface TerminationResult {
	done: boolean;
	reason?: string;
}

export function checkTermination(state: MissionState): TerminationResult {
	if (state.target !== undefined && state.best) {
		const hit = state.direction === "lower" ? state.best.metric <= state.target : state.best.metric >= state.target;
		if (hit) return { done: true, reason: `target ${state.target} reached` };
	}
	if (state.maxIterations !== undefined && state.iteration >= state.maxIterations) {
		return { done: true, reason: `max iterations (${state.maxIterations}) reached` };
	}
	if (state.maxPlateau !== undefined && state.plateau >= state.maxPlateau) {
		return { done: true, reason: `plateau (${state.maxPlateau}) reached` };
	}
	return { done: false };
}
