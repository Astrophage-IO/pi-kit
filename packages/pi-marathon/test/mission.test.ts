import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
	checkTermination,
	createState,
	initMission,
	isPaused,
	isStopRequested,
	marathonPaths,
	readState,
	resolveMarathonDir,
	writeState,
	type MissionState,
} from "../src/mission.ts";
import { RESULTS_HEADER } from "../src/results.ts";

function tempDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "pi-marathon-mission-"));
}

test("resolveMarathonDir prefers an explicit override, then env, then <cwd>/.marathon", () => {
	const cwd = "/tmp/project";
	assert.equal(resolveMarathonDir(cwd), path.join(cwd, ".marathon"));
	assert.equal(resolveMarathonDir(cwd, "/abs/dir"), "/abs/dir");
	assert.equal(resolveMarathonDir(cwd, "rel/dir"), path.resolve(cwd, "rel/dir"));
});

test("initMission scaffolds state, config, and a results header", async () => {
	const dir = tempDir();
	try {
		const paths = marathonPaths(dir);
		const state = await initMission(paths, { goal: "lower latency", metricName: "p99_ms", direction: "lower", target: 90 });
		assert.equal(state.status, "running");
		assert.equal(state.iteration, 0);
		assert.ok(existsSync(paths.runs));
		assert.equal(readFileSync(paths.results, "utf8").split("\n")[0], RESULTS_HEADER);
		assert.match(readFileSync(paths.config, "utf8"), /lower latency/);
		const reread = await readState(paths);
		assert.equal(reread?.metricName, "p99_ms");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeState refreshes updatedAt and round-trips through readState", async () => {
	const dir = tempDir();
	try {
		const paths = marathonPaths(dir);
		const state = createState({ goal: "g", metricName: "m", direction: "higher" }, new Date(0));
		await writeState(paths, state);
		const reread = await readState(paths);
		assert.ok(reread);
		assert.notEqual(reread?.updatedAt, new Date(0).toISOString());
		assert.equal(reread?.direction, "higher");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readState throws on an unknown apiVersion", async () => {
	const dir = tempDir();
	try {
		const paths = marathonPaths(dir);
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.state, JSON.stringify({ apiVersion: "pi-marathon-state/v999" }), "utf8");
		await assert.rejects(() => readState(paths), /Unsupported pi-marathon state apiVersion/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pause and stop sentinels are detected by path", async () => {
	const dir = tempDir();
	try {
		const paths = marathonPaths(dir);
		await initMission(paths, { goal: "g", metricName: "m", direction: "lower" });
		assert.equal(isPaused(paths), false);
		assert.equal(isStopRequested(paths), false);
		writeFileSync(paths.pause, "", "utf8");
		writeFileSync(paths.stop, "", "utf8");
		assert.equal(isPaused(paths), true);
		assert.equal(isStopRequested(paths), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function baseState(overrides: Partial<MissionState> = {}): MissionState {
	return { ...createState({ goal: "g", metricName: "m", direction: "lower" }), ...overrides };
}

test("checkTermination fires on target, then max iterations, then plateau", () => {
	assert.deepEqual(checkTermination(baseState()), { done: false });

	const target = baseState({ direction: "lower", target: 90, best: { n: 4, metric: 88 } });
	assert.equal(checkTermination(target).done, true);

	const targetHigher = baseState({ direction: "higher", target: 0.9, best: { n: 4, metric: 0.95 } });
	assert.equal(checkTermination(targetHigher).done, true);

	const targetNotHit = baseState({ direction: "lower", target: 90, best: { n: 4, metric: 95 } });
	assert.equal(checkTermination(targetNotHit).done, false);

	const maxIter = baseState({ maxIterations: 5, iteration: 5 });
	assert.match(checkTermination(maxIter).reason ?? "", /max iterations/);

	const plateau = baseState({ maxPlateau: 3, plateau: 3 });
	assert.match(checkTermination(plateau).reason ?? "", /plateau/);
});
