import type { MissionState } from "./mission.ts";
import { formatMetric, type ExperimentRow } from "./results.ts";

export interface RenderStatusOptions {
	/** Context window usage as a fraction 0..1, if known. */
	contextPercent?: number | null;
	/** Number of recent experiments to list. Default 5. */
	recent?: number;
}

function percentDelta(direction: "lower" | "higher", baseline: number, value: number): string {
	if (!Number.isFinite(baseline) || baseline === 0) return "";
	const change = ((value - baseline) / Math.abs(baseline)) * 100;
	const better = direction === "lower" ? change < 0 : change > 0;
	const sign = change > 0 ? "+" : "";
	return ` (${sign}${change.toFixed(1)}%${better ? "" : " worse"})`;
}

export function renderStatus(state: MissionState, rows: ExperimentRow[], options: RenderStatusOptions = {}): string {
	const baseline = rows.find((row) => row.status === "baseline");
	const last = rows[rows.length - 1];
	const recent = rows.slice(-(options.recent ?? 5)).reverse();
	const keeps = rows.filter((row) => row.status === "keep").length;
	const discards = rows.filter((row) => row.status === "discard").length;
	const crashes = rows.filter((row) => row.status === "crash").length;

	const lines: string[] = [];
	lines.push(`marathon: ${state.goal}`);
	const ctx = formatContext(options.contextPercent);
	lines.push(`status: ${state.status}   iteration: ${state.iteration}   plateau: ${state.plateau}${ctx ? `   ${ctx}` : ""}`);
	if (state.terminationReason) lines.push(`termination: ${state.terminationReason}`);
	lines.push("");
	lines.push(`metric: ${state.metricName} (${state.direction}=better)`);
	if (baseline) lines.push(`  baseline ${formatMetric(baseline.metric)}`);
	if (state.best) {
		const delta = baseline ? percentDelta(state.direction, baseline.metric, state.best.metric) : "";
		lines.push(`  best     ${formatMetric(state.best.metric)}  (#${state.best.n})${delta}`);
	}
	if (last) lines.push(`  last     ${formatMetric(last.metric)}  (#${last.n}, ${last.status})`);
	if (state.target !== undefined) lines.push(`  target   ${formatMetric(state.target)}`);
	lines.push("");
	lines.push(`experiments: ${rows.length}  (keeps:${keeps} discards:${discards} crashes:${crashes})`);
	if (recent.length > 0) {
		lines.push("");
		lines.push("recent:");
		for (const row of recent) {
			lines.push(`  #${row.n} ${row.status.padEnd(8)} ${row.description}`);
		}
	}
	return lines.join("\n");
}

function formatContext(percent: number | null | undefined): string {
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return "";
	return `ctx ${Math.round(percent * 100)}%`;
}
