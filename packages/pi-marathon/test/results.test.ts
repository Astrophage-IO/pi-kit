import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
	RESULTS_HEADER,
	appendResult,
	formatMetric,
	formatRow,
	isImprovement,
	parseRow,
	readResults,
	sanitizeCell,
	type ExperimentRow,
} from "../src/results.ts";

function tempDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "pi-marathon-results-"));
}

test("formatMetric pads to six decimals and maps non-finite to zero", () => {
	assert.equal(formatMetric(0.9979), "0.997900");
	assert.equal(formatMetric(Number.NaN), "0.000000");
	assert.equal(formatMetric(Number.POSITIVE_INFINITY), "0.000000");
});

test("sanitizeCell strips tabs and newlines so TSV columns stay intact", () => {
	assert.equal(sanitizeCell("a\tb\nc"), "a b c");
});

test("formatRow and parseRow round-trip an experiment row", () => {
	const row: ExperimentRow = { n: 3, commit: "a1b2c3d", metric: 0.9932, status: "keep", description: "increase LR to 0.04" };
	const line = formatRow(row);
	assert.equal(line, "3\ta1b2c3d\t0.993200\tkeep\tincrease LR to 0.04");
	assert.deepEqual(parseRow(line), row);
});

test("parseRow rejects malformed and unknown-status lines", () => {
	assert.equal(parseRow("not enough columns"), undefined);
	assert.equal(parseRow("x\tcommit\t0.1\tkeep\tdesc"), undefined);
	assert.equal(parseRow("1\tcommit\t0.1\tbogus\tdesc"), undefined);
});

test("appendResult writes a header once and reads rows back, skipping the header", async () => {
	const dir = tempDir();
	try {
		const results = path.join(dir, "results.tsv");
		await appendResult(results, { n: 0, commit: "aaa0000", metric: 1.0, status: "baseline", description: "baseline" });
		await appendResult(results, { n: 1, commit: "bbb1111", metric: 0.95, status: "keep", description: "tweak" });
		const text = readFileSync(results, "utf8");
		assert.equal(text.split("\n")[0], RESULTS_HEADER);
		const rows = await readResults(results);
		assert.equal(rows.length, 2);
		assert.equal(rows[0]?.status, "baseline");
		assert.equal(rows[1]?.metric, 0.95);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readResults returns empty for a missing file", async () => {
	const dir = tempDir();
	try {
		assert.deepEqual(await readResults(path.join(dir, "nope.tsv")), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("isImprovement respects metric direction and treats a missing best as beatable", () => {
	assert.equal(isImprovement("lower", 0.9, undefined), true);
	assert.equal(isImprovement("lower", 0.9, 1.0), true);
	assert.equal(isImprovement("lower", 1.1, 1.0), false);
	assert.equal(isImprovement("higher", 0.9, 0.8), true);
	assert.equal(isImprovement("higher", 0.7, 0.8), false);
});
