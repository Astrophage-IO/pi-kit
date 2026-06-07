import assert from "node:assert/strict";
import { test } from "bun:test";
import { buildCompactionInstructions } from "../src/compaction-summary.ts";
import { createState, marathonPaths, type MissionState } from "../src/mission.ts";
import type { ExperimentRow } from "../src/results.ts";

function state(overrides: Partial<MissionState> = {}): MissionState {
	return { ...createState({ goal: "lower val_bpb", metricName: "val_bpb", direction: "lower" }), ...overrides };
}

const rows: ExperimentRow[] = [
	{ n: 0, commit: "aaa0000", metric: 0.9979, status: "baseline", description: "baseline" },
	{ n: 1, commit: "bbb1111", metric: 0.9932, status: "keep", description: "increase LR to 0.04" },
];

test("buildCompactionInstructions embeds goal, metric, baseline, and best", () => {
	const text = buildCompactionInstructions(
		state({ iteration: 2, best: { n: 1, metric: 0.9932, commit: "bbb1111", description: "increase LR to 0.04" } }),
		rows,
	);
	assert.match(text, /Goal: lower val_bpb/);
	assert.match(text, /val_bpb \(lower=better\)/);
	assert.match(text, /Baseline: 0\.997900/);
	assert.match(text, /Best so far: 0\.993200 at #1/);
	assert.match(text, /keep looping without asking the human/);
});

test("buildCompactionInstructions lists recent experiments and on-disk paths when provided", () => {
	const paths = marathonPaths("/tmp/project");
	const text = buildCompactionInstructions(state(), rows, paths);
	assert.match(text, /#1 keep 0\.993200 — increase LR to 0\.04/);
	assert.match(text, /results\.tsv/);
	assert.match(text, /best\.md/);
});

test("buildCompactionInstructions handles a mission with no best yet", () => {
	const text = buildCompactionInstructions(state(), []);
	assert.match(text, /Best so far: \(none yet\)/);
	assert.match(text, /Baseline: \(none recorded yet\)/);
});
