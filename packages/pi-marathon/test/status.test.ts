import assert from "node:assert/strict";
import { test } from "bun:test";
import { createState, type MissionState } from "../src/mission.ts";
import type { ExperimentRow } from "../src/results.ts";
import { renderStatus } from "../src/status.ts";

function state(overrides: Partial<MissionState> = {}): MissionState {
	return {
		...createState({ goal: "reduce p99 latency", metricName: "p99_ms", direction: "lower" }),
		...overrides,
	};
}

const rows: ExperimentRow[] = [
	{ n: 0, commit: "aaa0000", metric: 142, status: "baseline", description: "baseline" },
	{ n: 1, commit: "bbb1111", metric: 120, status: "keep", description: "batch getOrderDetails" },
	{ n: 2, commit: "ccc2222", metric: 130, status: "discard", description: "raw SQL switch" },
];

test("renderStatus shows goal, metric, baseline, best, last, and recent experiments", () => {
	const text = renderStatus(
		state({ iteration: 3, plateau: 1, best: { n: 1, metric: 120, description: "batch getOrderDetails" } }),
		rows,
	);
	assert.match(text, /marathon: reduce p99 latency/);
	assert.match(text, /p99_ms \(lower=better\)/);
	assert.match(text, /baseline 142\.000000/);
	assert.match(text, /best {5}120\.000000 {2}\(#1\)/);
	assert.match(text, /last {5}130\.000000 {2}\(#2, discard\)/);
	assert.match(text, /#2 discard/);
	assert.match(text, /keeps:1 discards:1 crashes:0/);
});

test("renderStatus reports a percentage delta versus baseline for the best", () => {
	const text = renderStatus(state({ best: { n: 1, metric: 120 } }), rows);
	assert.match(text, /-15\.5%/);
});

test("renderStatus surfaces context usage and termination reason when present", () => {
	const text = renderStatus(state({ status: "done", terminationReason: "target 90 reached" }), rows, { contextPercent: 0.62 });
	assert.match(text, /ctx 62%/);
	assert.match(text, /termination: target 90 reached/);
});

test("renderStatus handles an empty mission without throwing", () => {
	const text = renderStatus(state(), []);
	assert.match(text, /experiments: 0/);
});
