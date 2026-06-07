#!/usr/bin/env bun
/**
 * End-to-end smoke test for the pi-marathon extension, driven through a mock pi host so it
 * exercises the real tool/hook code (configure -> run -> record -> status -> self-loop) without
 * an LLM. Run with: bun run packages/pi-marathon/test/marathon-smoke.ts
 *
 * Not part of `bun test` (it is a script, like pi-bus/test/pi-rpc-smoke.ts).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import piMarathonExtension from "../extensions/pi-marathon.ts";
import { marathonPaths, readState } from "../src/mission.ts";
import { readResults } from "../src/results.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Tool = { name: string; execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; details: unknown }> };

function buildMockPi() {
	const flags = new Map<string, boolean | string>();
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const sent: Array<{ customType?: string; triggerTurn?: boolean }> = [];
	const pi = {
		registerFlag(name: string, opts: { default?: boolean | string }) {
			flags.set(name, opts.default ?? "");
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(def: Tool) {
			tools.set(def.name, def);
		},
		registerCommand(name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, opts);
		},
		registerMessageRenderer() {},
		sendMessage(message: { customType?: string }, options?: { triggerTurn?: boolean }) {
			sent.push({ customType: message.customType, triggerTurn: options?.triggerTurn });
		},
	};
	return { pi, flags, handlers, tools, commands, sent };
}

function buildMockCtx(cwd: string) {
	const statuses: Array<string | undefined> = [];
	return {
		cwd,
		hasUI: false,
		ui: {
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			notify: () => {},
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 12000, contextWindow: 200000, percent: 6 }),
		statuses,
	};
}

async function fire(handlers: Map<string, Handler[]>, event: string, ctx: unknown): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
}

async function callTool(tools: Map<string, Tool>, name: string, params: unknown, ctx: unknown): Promise<string> {
	const tool = tools.get(name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	const result = await tool.execute(`${name}-call`, params, undefined, undefined, ctx);
	return result.content.map((part) => part.text).join("\n");
}

async function main(): Promise<void> {
	process.env.PI_MARATHON_TICK_DELAY_MS = "50";
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-marathon-smoke-"));
	try {
		// A trivial "training script" that prints noise plus one metric line.
		const measure = path.join(dir, "measure.sh");
		writeFileSync(measure, "#!/usr/bin/env bash\necho 'lots of noise that must NOT reach context'\necho \"metric: ${1:-0.500000}\"\n", { mode: 0o755 });

		const { pi, handlers, tools, sent } = buildMockPi();
		piMarathonExtension(pi as never);
		const ctx = buildMockCtx(dir);

		await fire(handlers, "session_start", ctx);

		console.log("--- marathon_configure ---");
		console.log(await callTool(tools, "marathon_configure", { goal: "minimize loss", metricName: "loss", direction: "lower", target: 0.3 }, ctx));

		console.log("\n--- marathon_run (baseline) ---");
		const baselineOut = await callTool(tools, "marathon_run", { command: `bash ${measure} 0.500000`, extract: "^metric:" }, ctx);
		console.log(baselineOut);
		assert.ok(baselineOut.includes("metric: 0.500000"), "run output should include the metric line");
		assert.ok(!baselineOut.includes("noise"), "run output must NOT leak non-matching noise into context");

		await callTool(tools, "marathon_record", { n: 0, commit: "base000", metric: 0.5, status: "baseline", description: "baseline" }, ctx);

		console.log("\n--- experiment #1 (improves) ---");
		await callTool(tools, "marathon_run", { command: `bash ${measure} 0.420000`, extract: "^metric:" }, ctx);
		console.log(await callTool(tools, "marathon_record", { n: 1, commit: "exp1aaa", metric: 0.42, status: "keep", description: "tune lr" }, ctx));

		// Loop driver: a turn that made progress while running should re-trigger the next turn.
		await fire(handlers, "agent_end", ctx);
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.ok(sent.some((m) => m.customType === "marathon.tick" && m.triggerTurn === true), "auto-loop should re-trigger a turn while running");

		console.log("\n--- experiment #2 (hits target) ---");
		await callTool(tools, "marathon_run", { command: `bash ${measure} 0.250000`, extract: "^metric:" }, ctx);
		const recordOut = await callTool(tools, "marathon_record", { n: 2, commit: "exp2bbb", metric: 0.25, status: "keep", description: "better init" }, ctx);
		console.log(recordOut);
		assert.match(recordOut, /TERMINATION/, "hitting the target should report termination");

		console.log("\n--- marathon_status ---");
		console.log(await callTool(tools, "marathon_status", {}, ctx));

		// State assertions.
		const paths = marathonPaths(dir);
		const state = await readState(paths);
		assert.equal(state?.best?.metric, 0.25, "best should be the lowest metric");
		assert.equal(state?.status, "done", "target hit should mark the mission done");
		const rows = await readResults(paths.results);
		assert.equal(rows.length, 3, "three experiments should be recorded");

		// A finished ("done") mission must NOT keep looping.
		const ticksBeforeDone = sent.filter((m) => m.customType === "marathon.tick").length;
		await fire(handlers, "agent_end", ctx);
		await new Promise((resolve) => setTimeout(resolve, 120));
		const ticksAfterDone = sent.filter((m) => m.customType === "marathon.tick").length;
		assert.equal(ticksAfterDone, ticksBeforeDone, "a finished mission must not re-trigger the loop");

		console.log("\nOK: pi-marathon smoke passed (configure, redirected run, record, loop-while-running, termination, no-loop-when-done).");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error("SMOKE FAILED:", error instanceof Error ? error.stack ?? error.message : String(error));
	process.exit(1);
});
