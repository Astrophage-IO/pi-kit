import type { MarathonPaths, MissionState } from "./mission.ts";
import { formatMetric, type ExperimentRow } from "./results.ts";

/**
 * Build the mission-state note injected after pi compacts the context window (via the
 * `session_compact` event). It re-grounds the resumed agent so it can continue the LOOP FOREVER
 * cycle immediately, then re-read `.marathon/` on disk for the full history.
 */
export function buildCompactionInstructions(
	state: MissionState,
	rows: ExperimentRow[],
	paths?: Pick<MarathonPaths, "results" | "log" | "best" | "state">,
	recent = 8,
): string {
	const baseline = rows.find((row) => row.status === "baseline");
	const tail = rows.slice(-recent).map((row) => `  #${row.n} ${row.status} ${formatMetric(row.metric)} — ${row.description}`);

	const lines: string[] = [
		"This is an autonomous pi-marathon research session that must keep iterating after compaction.",
		"Preserve ALL of the following mission state verbatim in the summary so the loop can continue:",
		"",
		`- Goal: ${state.goal}`,
		`- Metric: ${state.metricName} (${state.direction}=better)`,
		`- Target: ${state.target ?? "(run until stopped)"}`,
		`- Status: ${state.status}; iteration ${state.iteration}; plateau ${state.plateau}`,
		baseline ? `- Baseline: ${formatMetric(baseline.metric)}` : "- Baseline: (none recorded yet)",
		state.best
			? `- Best so far: ${formatMetric(state.best.metric)} at #${state.best.n} (${state.best.commit ?? "no commit"}) — ${state.best.description ?? ""}`
			: "- Best so far: (none yet)",
	];

	if (tail.length > 0) {
		lines.push("- Recent experiments:");
		lines.push(...tail);
	}

	lines.push(
		"",
		"In the Next Steps section, instruct the resumed agent to: (1) re-read the on-disk state files,",
		"(2) THINK about the next hypothesis, (3) run exactly one more experiment via marathon_run,",
		"(4) record it via marathon_record, and (5) keep looping without asking the human to continue.",
	);

	if (paths) {
		lines.push(
			"",
			"On-disk source of truth to re-read after compaction:",
			`  ${paths.results}  (full experiment history)`,
			`  ${paths.best}  (current best config)`,
			`  ${paths.log}  (THINK/RUN/REFLECT narrative)`,
			`  ${paths.state}  (machine state)`,
		);
	}

	return lines.join("\n");
}
