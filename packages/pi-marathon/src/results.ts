import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ExperimentStatus = "baseline" | "keep" | "discard" | "crash";

export const RESULTS_HEADER = "n\tcommit\tmetric\tstatus\tdescription";

const KNOWN_STATUSES = new Set<ExperimentStatus>(["baseline", "keep", "discard", "crash"]);

export interface ExperimentRow {
	n: number;
	commit: string;
	metric: number;
	status: ExperimentStatus;
	description: string;
}

export function formatMetric(metric: number): string {
	if (!Number.isFinite(metric)) return "0.000000";
	return metric.toFixed(6);
}

export function sanitizeCell(value: string): string {
	return value.replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}

export function formatRow(row: ExperimentRow): string {
	return [row.n, sanitizeCell(row.commit), formatMetric(row.metric), row.status, sanitizeCell(row.description)].join("\t");
}

export function parseRow(line: string): ExperimentRow | undefined {
	const cols = line.split("\t");
	if (cols.length < 5) return undefined;
	const n = Number(cols[0]);
	if (!Number.isInteger(n)) return undefined;
	const status = cols[3] as ExperimentStatus;
	if (!KNOWN_STATUSES.has(status)) return undefined;
	const metric = Number(cols[2]);
	return {
		n,
		commit: cols[1] ?? "",
		metric: Number.isFinite(metric) ? metric : 0,
		status,
		description: cols.slice(4).join("\t"),
	};
}

export async function ensureResultsFile(resultsPath: string): Promise<void> {
	if (existsSync(resultsPath)) return;
	await mkdir(path.dirname(resultsPath), { recursive: true });
	await writeFile(resultsPath, `${RESULTS_HEADER}\n`, "utf8");
}

export async function appendResult(resultsPath: string, row: ExperimentRow): Promise<void> {
	await ensureResultsFile(resultsPath);
	await appendFile(resultsPath, `${formatRow(row)}\n`, "utf8");
}

export async function readResults(resultsPath: string): Promise<ExperimentRow[]> {
	if (!existsSync(resultsPath)) return [];
	const text = await readFile(resultsPath, "utf8");
	const rows: ExperimentRow[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line || line === RESULTS_HEADER) continue;
		const parsed = parseRow(line);
		if (parsed) rows.push(parsed);
	}
	return rows;
}

/** True when `candidate` beats `best` for the given metric direction. A missing best is always beaten. */
export function isImprovement(direction: "lower" | "higher", candidate: number, best: number | undefined): boolean {
	if (best === undefined || !Number.isFinite(best)) return true;
	return direction === "lower" ? candidate < best : candidate > best;
}
