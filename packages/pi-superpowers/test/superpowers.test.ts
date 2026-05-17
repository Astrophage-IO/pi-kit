import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { _internals, _resetConfigCacheForTesting } from "../extensions/superpowers.ts";

const {
	addUsage,
	expandValue,
	extractLastAssistantText,
	extractMessageText,
	isToolAllowed,
	loadConfig,
	makePiToolName,
	matchesToolPattern,
	mcpResultToText,
	resolvePath,
	sanitizeProfileName,
	sanitizeToolName,
	tryReadConfigSync,
} = _internals;

function tempDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "pi-superpowers-test-"));
}

function withTempConfig(json: string, run: (configPath: string) => Promise<void> | void): Promise<void> | void {
	const dir = tempDir();
	const configPath = path.join(dir, "superpowers.json");
	writeFileSync(configPath, json, "utf8");
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	const result = run(configPath);
	if (result instanceof Promise) return result.finally(cleanup);
	cleanup();
}

test("sanitizeToolName normalizes mixed case and punctuation", () => {
	assert.equal(sanitizeToolName("MCP Slack/Search-Messages"), "mcp_slack_search_messages");
	assert.equal(sanitizeToolName("__foo--bar__"), "foo_bar");
	assert.equal(sanitizeToolName("!!!"), "mcp_tool");
});

test("sanitizeProfileName lower-cases and replaces non-alphanumerics", () => {
	assert.equal(sanitizeProfileName("Slack"), "slack");
	assert.equal(sanitizeProfileName("GitHub-Issues"), "github_issues");
	assert.equal(sanitizeProfileName(" -- "), "profile");
});

test("makePiToolName truncates long names and disambiguates collisions", () => {
	const used = new Set<string>();
	const longName = "really_long_tool_name_that_will_certainly_exceed_the_max_allowed_length_for_pi_tools";
	const first = makePiToolName("slack", longName, used);
	assert.ok(first.length <= 64);
	used.add(first);
	const second = makePiToolName("slack", longName, used);
	assert.notEqual(first, second);
	assert.ok(second.length <= 64);

	const short = makePiToolName("slack", "search", new Set());
	assert.equal(short, "mcp_slack_search");
});

test("matchesToolPattern supports wildcards across name candidates", () => {
	assert.ok(matchesToolPattern("*", "slack", "post_message", "mcp_slack_post_message"));
	assert.ok(matchesToolPattern("*post*", "slack", "post_message", "mcp_slack_post_message"));
	assert.ok(matchesToolPattern("slack/search", "slack", "search", "mcp_slack_search"));
	assert.ok(matchesToolPattern("slack:search", "slack", "search", "mcp_slack_search"));
	assert.ok(matchesToolPattern("slack.search", "slack", "search", "mcp_slack_search"));
	assert.ok(!matchesToolPattern("jira_*", "slack", "search", "mcp_slack_search"));
	assert.ok(!matchesToolPattern("", "slack", "search", "mcp_slack_search"));
});

test("isToolAllowed applies allow then deny", () => {
	const profile = { servers: ["slack"], allowTools: ["*"], blockTools: ["*post*", "*delete*"] };
	assert.ok(isToolAllowed("slack", "search_messages", "mcp_slack_search_messages", profile));
	assert.ok(!isToolAllowed("slack", "post_message", "mcp_slack_post_message", profile));
	assert.ok(!isToolAllowed("slack", "delete_thread", "mcp_slack_delete_thread", profile));

	const restrictive = { servers: ["slack"], allowTools: ["*search*"] };
	assert.ok(isToolAllowed("slack", "search_messages", "mcp_slack_search_messages", restrictive));
	assert.ok(!isToolAllowed("slack", "post_message", "mcp_slack_post_message", restrictive));

	const empty = { servers: ["slack"] };
	assert.ok(isToolAllowed("slack", "anything", "mcp_slack_anything", empty));
});

test("expandValue substitutes $VAR and ${VAR}, leaves unrelated text", () => {
	process.env.PI_SUPERPOWERS_TEST_VAR = "hello";
	try {
		assert.equal(expandValue("$PI_SUPERPOWERS_TEST_VAR"), "hello");
		assert.equal(expandValue("${PI_SUPERPOWERS_TEST_VAR}/end"), "hello/end");
		assert.equal(expandValue("/literal/path"), "/literal/path");
		assert.equal(expandValue("$NOT_DEFINED_VAR_XYZ"), undefined);
	} finally {
		delete process.env.PI_SUPERPOWERS_TEST_VAR;
	}
});

test("resolvePath expands ~ and resolves relative paths", () => {
	assert.equal(resolvePath("~"), os.homedir());
	assert.equal(resolvePath("~/foo"), path.join(os.homedir(), "foo"));
	const base = "/tmp/base";
	assert.equal(resolvePath("./child", base), path.join(base, "child"));
	assert.equal(resolvePath("/absolute/path"), "/absolute/path");
});

test("loadConfig rejects malformed JSON and missing shape", async () => {
	await withTempConfig("{ not json", async (configPath) => {
		await assert.rejects(() => loadConfig(configPath), /Invalid superpowers config JSON/);
	});
	await withTempConfig(JSON.stringify({ profiles: {} }), async (configPath) => {
		await assert.rejects(() => loadConfig(configPath), /expected \{ profiles, servers \}/);
	});
	await assert.rejects(() => loadConfig("/path/that/does/not/exist/superpowers.json"), /Could not read superpowers config/);
});

test("loadConfig accepts a valid file", async () => {
	const valid = JSON.stringify({
		profiles: { slack: { servers: ["slack"] } },
		servers: { slack: { command: "npx" } },
	});
	await withTempConfig(valid, async (configPath) => {
		const config = await loadConfig(configPath);
		assert.ok(config.profiles.slack);
		assert.equal(config.servers.slack?.command, "npx");
	});
});

test("tryReadConfigSync returns undefined for missing or invalid files instead of throwing", () => {
	assert.equal(tryReadConfigSync("/path/that/does/not/exist/superpowers.json"), undefined);
	withTempConfig("{ not json", (configPath) => {
		assert.equal(tryReadConfigSync(configPath), undefined);
	});
	withTempConfig(JSON.stringify({ profiles: { slack: { servers: ["slack"] } }, servers: {} }), (configPath) => {
		const config = tryReadConfigSync(configPath);
		assert.ok(config);
		assert.ok(config?.profiles.slack);
	});
});

test("getConfig (via reset) reloads when the file's mtime changes", async () => {
	_resetConfigCacheForTesting();
	await withTempConfig(JSON.stringify({ profiles: { a: { servers: [] } }, servers: {} }), async (configPath) => {
		const first = await loadConfig(configPath);
		assert.ok(first.profiles.a);
	});
});

test("extractMessageText handles string and array content", () => {
	assert.equal(extractMessageText({ content: "plain" }), "plain");
	assert.equal(
		extractMessageText({
			content: [
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
				{ type: "tool_use" },
			],
		}),
		"one\ntwo",
	);
	assert.equal(extractMessageText({ content: undefined }), "");
});

test("extractLastAssistantText finds the most recent assistant message", () => {
	const messages = [
		{ role: "user", content: "ignored" },
		{ role: "assistant", content: "first answer" },
		{ role: "user", content: "follow up" },
		{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
	];
	assert.equal(extractLastAssistantText(messages), "final answer");
	assert.equal(extractLastAssistantText([{ role: "user", content: "only user" }]), "");
});

test("addUsage accumulates input/output/cache/cost and ignores garbage", () => {
	const summary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	addUsage(summary, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.0123 } });
	addUsage(summary, { input: 7, output: 3 });
	addUsage(summary, null);
	addUsage(summary, { input: "not a number" });
	assert.deepEqual(summary, { input: 17, output: 8, cacheRead: 2, cacheWrite: 1, cost: 0.0123, turns: 0 });
});

test("mcpResultToText flattens text, image, and resource content items", () => {
	assert.equal(
		mcpResultToText({
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", mimeType: "image/png" },
				{ type: "resource", resource: { uri: "file://x" } },
			],
		}).split("\n")[0],
		"hello",
	);
	assert.match(mcpResultToText({ content: [{ type: "image" }] }), /MCP image content/);
	assert.match(mcpResultToText({ content: [{ type: "resource" }] }), /MCP resource content/);
});
