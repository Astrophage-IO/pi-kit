import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
	appendClaim,
	appendVerdict,
	classifyClaim,
	evaluateAll,
	evaluateClaim,
	makeClaimId,
	parseClaimsBlock,
	parseVerdictBlock,
	readClaims,
	readVerdicts,
	tallyVerdicts,
	type Claim,
	type ClaimVerdict,
} from "../src/claims.ts";

function tempDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "pi-marathon-claims-"));
}

function verdict(claimId: string, v: ClaimVerdict["verdict"], withCitation = true): ClaimVerdict {
	return { claimId, verifier: `v-${Math.random().toString(36).slice(2)}`, verdict: v, citation: withCitation ? "src:1" : undefined, createdAt: new Date().toISOString() };
}

test("makeClaimId is 1-based", () => {
	assert.equal(makeClaimId(0), "c1");
	assert.equal(makeClaimId(4), "c5");
});

test("tallyVerdicts separates grounded supports from ungrounded", () => {
	const tally = tallyVerdicts([verdict("c1", "supported", true), verdict("c1", "supported", false), verdict("c1", "refuted"), verdict("c1", "unverifiable")]);
	assert.equal(tally.groundedSupports, 1);
	assert.equal(tally.ungroundedSupports, 1);
	assert.equal(tally.refutes, 1);
	assert.equal(tally.unverifiables, 1);
	assert.equal(tally.total, 4);
});

test("classifyClaim applies the grounded-quorum gate", () => {
	assert.equal(classifyClaim({ total: 5, groundedSupports: 5, ungroundedSupports: 0, partials: 0, refutes: 0, unverifiables: 0 }, 5), "confirmed");
	// ungrounded supports do NOT count toward quorum
	assert.equal(classifyClaim({ total: 5, groundedSupports: 4, ungroundedSupports: 1, partials: 0, refutes: 0, unverifiables: 0 }, 5), "contested");
	assert.equal(classifyClaim({ total: 5, groundedSupports: 0, ungroundedSupports: 0, partials: 0, refutes: 5, unverifiables: 0 }, 5), "refuted");
	assert.equal(classifyClaim({ total: 2, groundedSupports: 2, ungroundedSupports: 0, partials: 0, refutes: 0, unverifiables: 0 }, 5), "pending");
	assert.equal(classifyClaim({ total: 5, groundedSupports: 0, ungroundedSupports: 0, partials: 0, refutes: 0, unverifiables: 5 }, 5), "unverifiable");
	assert.equal(classifyClaim({ total: 5, groundedSupports: 2, ungroundedSupports: 0, partials: 0, refutes: 2, unverifiables: 1 }, 5), "contested");
});

test("evaluateAll computes agreement as confirmed/total", () => {
	const claims: Claim[] = [
		{ id: "c1", source: "repo", statement: "a", citations: ["x"], createdAt: "t" },
		{ id: "c2", source: "slack", statement: "b", citations: ["y"], createdAt: "t" },
	];
	const verdicts = [verdict("c1", "supported"), verdict("c1", "supported"), verdict("c2", "refuted"), verdict("c2", "refuted")];
	const result = evaluateAll(claims, verdicts, 2);
	assert.equal(result.counts.confirmed, 1);
	assert.equal(result.counts.refuted, 1);
	assert.equal(result.agreement, 0.5);
});

test("jsonl ledgers round-trip claims and verdicts", async () => {
	const dir = tempDir();
	try {
		const claimsFile = path.join(dir, "claims.jsonl");
		const verdictsFile = path.join(dir, "verdicts.jsonl");
		await appendClaim(claimsFile, { id: "c1", source: "jira", statement: "blocked", citations: ["PROJ-1"], createdAt: "t" });
		await appendVerdict(verdictsFile, verdict("c1", "supported"));
		assert.equal((await readClaims(claimsFile)).length, 1);
		assert.equal((await readVerdicts(verdictsFile)).length, 1);
		assert.equal(evaluateClaim("c1", await readVerdicts(verdictsFile), 1).status, "confirmed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseClaimsBlock reads JSON lines and skips malformed ones", () => {
	const report = `# report\nsome prose\n\n<claims>\n{"statement":"X happened","citations":["http://s/1"],"confidence":"high"}\nnot json\n{"statement":"","citations":[]}\n{"statement":"Y too","citations":["p:2"]}\n</claims>\n`;
	const claims = parseClaimsBlock(report);
	assert.equal(claims.length, 2);
	assert.equal(claims[0]?.statement, "X happened");
	assert.deepEqual(claims[1]?.citations, ["p:2"]);
});

test("parseVerdictBlock validates the verdict enum", () => {
	assert.equal(parseVerdictBlock(`ok <verdict>{"verdict":"supported","citation":"s:1","quote":"q"}</verdict>`)?.verdict, "supported");
	assert.equal(parseVerdictBlock(`<verdict>{"verdict":"bogus"}</verdict>`), undefined);
	assert.equal(parseVerdictBlock("no block here"), undefined);
});
