import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { appendClaim, appendVerdict, type ClaimVerdict } from "../src/claims.ts";
import { compileReports, investigationPaths, reportFileFor, writeBrief } from "../src/investigation.ts";

function tempDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "pi-marathon-investigation-"));
}

test("investigationPaths nests under the marathon dir", () => {
	const paths = investigationPaths("/tmp/project");
	assert.equal(paths.dir, path.join("/tmp/project", ".marathon", "investigation"));
	assert.equal(reportFileFor(paths, "slack"), path.join(paths.reportsDir, "slack.md"));
});

test("writeBrief records the problem and numbered sub-questions", async () => {
	const dir = tempDir();
	try {
		const paths = investigationPaths(dir);
		await writeBrief(paths, "Why did checkout p99 regress?", ["What changed in the order service?", "Any Slack incident?"]);
		const text = readFileSync(paths.brief, "utf8");
		assert.match(text, /Why did checkout p99 regress\?/);
		assert.match(text, /1\. What changed in the order service\?/);
		assert.match(text, /2\. Any Slack incident\?/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compileReports writes index/report/contested and computes agreement", async () => {
	const dir = tempDir();
	try {
		const paths = investigationPaths(dir);
		await appendClaim(paths.claims, { id: "c1", source: "repo", statement: "retries capped at 3", citations: ["src/http.ts:42"], createdAt: "t" });
		await appendClaim(paths.claims, { id: "c2", source: "slack", statement: "incident on 3/4", citations: ["https://slack/1"], createdAt: "t" });

		const grounded = (claimId: string): ClaimVerdict => ({ claimId, verifier: `v-${claimId}-${Math.random()}`, verdict: "supported", citation: "re:1", createdAt: "t" });
		// c1 reaches quorum 2; c2 gets only one support -> pending
		await appendVerdict(paths.verdicts, grounded("c1"));
		await appendVerdict(paths.verdicts, grounded("c1"));
		await appendVerdict(paths.verdicts, grounded("c2"));

		const result = await compileReports(paths, 2);
		assert.equal(result.totalClaims, 2);
		assert.equal(result.counts.confirmed, 1);
		assert.equal(result.counts.pending, 1);
		assert.equal(result.agreement, 0.5);
		assert.ok(existsSync(paths.index) && existsSync(paths.report) && existsSync(paths.contested));
		assert.match(readFileSync(paths.report, "utf8"), /retries capped at 3/);
		assert.match(readFileSync(paths.contested, "utf8"), /incident on 3\/4/);
		assert.match(readFileSync(paths.index, "utf8"), /agreement: 50%/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
