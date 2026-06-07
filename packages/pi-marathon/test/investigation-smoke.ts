#!/usr/bin/env bun
/**
 * End-to-end smoke for the marathon-investigation extension, driven through a mock pi host and a
 * FAKE child-pi (so it exercises the real spawn -> report-to-disk -> claim-extract -> quorum ->
 * compile pipeline without any LLM). Run: bun run packages/pi-marathon/test/investigation-smoke.ts
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import marathonInvestigationExtension from "../extensions/marathon-investigation.ts";
import { investigationPaths } from "../src/investigation.ts";
import { readClaims } from "../src/claims.ts";

type Tool = { name: string; execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; details: unknown }> };

function buildMockPi(flags: Record<string, string>) {
	const flagMap = new Map<string, string>(Object.entries(flags));
	const tools = new Map<string, Tool>();
	const pi = {
		registerFlag(name: string, opts: { default?: boolean | string }) {
			if (!flagMap.has(name)) flagMap.set(name, String(opts.default ?? ""));
		},
		getFlag(name: string) {
			return flagMap.get(name);
		},
		on() {},
		registerTool(def: Tool) {
			tools.set(def.name, def);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
	};
	return { pi, tools };
}

async function call(tools: Map<string, Tool>, name: string, params: unknown, ctx: unknown): Promise<{ text: string; details: unknown }> {
	const tool = tools.get(name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	const result = await tool.execute(`${name}-call`, params, undefined, undefined, ctx);
	return { text: result.content.map((p) => p.text).join("\n"), details: result.details };
}

async function expectThrows(label: string, fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch {
		return;
	}
	throw new Error(`expected to throw: ${label}`);
}

const FAKE_PI = `#!/usr/bin/env bun
const argv = process.argv.slice(2).join(" ");
function emit(text) {
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }));
}
if (argv.includes("VERIFY CLAIM")) {
  emit('Re-opened the cited source and confirmed it.\\n<verdict>{"verdict":"supported","citation":"src/order.ts:10-20","quote":"timeout = 30s","confidence":"high"}</verdict>');
} else {
  emit('# repo report\\nThe order-service deploy raised the checkout timeout.\\n\\n<claims>\\n{"statement":"Checkout p99 regressed after the order-service deploy","citations":["src/order.ts:10-20"],"confidence":"high"}\\n</claims>');
}
`;

async function main(): Promise<void> {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-marathon-inv-smoke-"));
	try {
		const fakePi = path.join(dir, "fake-pi.ts");
		writeFileSync(fakePi, FAKE_PI, "utf8");
		chmodSync(fakePi, 0o755);

		const { pi, tools } = buildMockPi({
			"marathon-dir": "",
			"marathon-child-pi": fakePi,
			"marathon-verifiers": "3",
			"marathon-spawn-concurrency": "2",
			"marathon-spawn-timeout": "20000",
			"marathon-superpowers": "",
			"marathon-superpowers-config": path.join(dir, "no-superpowers.json"),
		});
		marathonInvestigationExtension(pi as never);
		const ctx = { cwd: dir, hasUI: false, ui: { setStatus() {}, notify() {} }, isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => undefined };

		console.log("--- investigation_plan ---");
		console.log((await call(tools, "investigation_plan", { problem: "Why did checkout p99 regress?", subQuestions: ["What changed in the order service?"] }, ctx)).text);

		console.log("\n--- gate: spawn before kickoff is blocked ---");
		await expectThrows("spawn_specialist before kickoff", () => call(tools, "spawn_specialist", { source: "repo", subQuestion: "x" }, ctx));
		console.log("blocked as expected");

		console.log("\n--- investigation_preflight (repo + slack, static) ---");
		const preflight = await call(tools, "investigation_preflight", { sources: ["repo", "slack"], live: false }, ctx);
		console.log(preflight.text);
		assert.match(preflight.text, /repo: ready/, "repo needs no MCP and should be ready");
		assert.match(preflight.text, /slack: missing-config/, "slack should be unavailable without a superpowers config");

		console.log("\n--- investigation_confirm without dropping slack is refused ---");
		await expectThrows("confirm with unmet source", () => call(tools, "investigation_confirm", {}, ctx));
		console.log("refused as expected (human must grant access or drop the source)");

		console.log("\n--- investigation_confirm proceeding without slack ---");
		console.log((await call(tools, "investigation_confirm", { proceedWithout: ["slack"] }, ctx)).text);

		console.log("\n--- gate: slack stays blocked, repo is allowed ---");
		await expectThrows("spawn slack after it was skipped", () => call(tools, "spawn_specialist", { source: "slack", subQuestion: "x" }, ctx));
		console.log("slack blocked as expected");

		console.log("\n--- spawn_specialist (repo) ---");
		const specialist = await call(tools, "spawn_specialist", { source: "repo", subQuestion: "What changed in the order service deploy?" }, ctx);
		console.log(specialist.text);
		assert.match(specialist.text, /1 claim/, "specialist should extract one claim");
		assert.ok(!specialist.text.includes("order-service deploy raised"), "the full report must NOT leak into the orchestrator summary");

		const paths = investigationPaths(dir);
		const reportText = readFileSync(path.join(paths.reportsDir, "repo.md"), "utf8");
		assert.match(reportText, /order-service deploy/, "the full report should be on disk");
		const claims = await readClaims(paths.claims);
		assert.equal(claims.length, 1, "one claim recorded");
		const claimId = claims[0]!.id;

		console.log("\n--- spawn_verifier (quorum 3) ---");
		const verify = await call(tools, "spawn_verifier", { claimId }, ctx);
		console.log(verify.text);
		assert.match(verify.text, /confirmed/, "three grounded supports should confirm the claim");

		console.log("\n--- report_compile ---");
		const compile = await call(tools, "report_compile", {}, ctx);
		console.log(compile.text);
		assert.match(compile.text, /agreement 100%/, "the single confirmed claim should give 100% agreement");
		assert.match(readFileSync(paths.report, "utf8"), /Checkout p99 regressed/, "confirmed claim should appear in report.md");

		console.log("\nOK: investigation smoke passed (plan, specialist->disk, claim-extract, independent quorum->confirmed, compile).");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error("SMOKE FAILED:", error instanceof Error ? error.stack ?? error.message : String(error));
	process.exit(1);
});
