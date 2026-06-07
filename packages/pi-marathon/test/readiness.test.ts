import assert from "node:assert/strict";
import { test } from "bun:test";
import {
	collectReferencedEnv,
	isConfirmed,
	parseSuperpowersConfig,
	sourceUsable,
	staticReadiness,
	unmetSources,
	type ReadinessReport,
	type SuperpowersConfig,
} from "../src/readiness.ts";

const config: SuperpowersConfig = {
	profiles: { slack: { servers: ["slack"] }, jira: { servers: ["atlassian"] } },
	servers: {
		slack: { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], env: { SLACK_BOT_TOKEN: "$SLACK_BOT_TOKEN", SLACK_TEAM_ID: "$SLACK_TEAM_ID" } },
		atlassian: { command: "npx", args: ["mcp-atlassian"], env: { JIRA_TOKEN: "${JIRA_TOKEN}" } },
	},
};

test("parseSuperpowersConfig accepts a valid shape and rejects others", () => {
	assert.ok(parseSuperpowersConfig(JSON.stringify(config)));
	assert.equal(parseSuperpowersConfig("{ not json"), undefined);
	assert.equal(parseSuperpowersConfig(JSON.stringify({ profiles: {} })), undefined);
});

test("collectReferencedEnv extracts $VAR and ${VAR} refs from a profile's servers", () => {
	assert.deepEqual(collectReferencedEnv(config, "slack").sort(), ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"]);
	assert.deepEqual(collectReferencedEnv(config, "jira"), ["JIRA_TOKEN"]);
});

test("repo is always ready without MCP", () => {
	const readiness = staticReadiness(undefined, "repo");
	assert.equal(readiness.ready, true);
	assert.match(readiness.detail, /built-in tools/);
});

test("staticReadiness reports missing config / profile; env is advisory, not a gate", () => {
	assert.equal(staticReadiness(undefined, "slack").status, "missing-config");
	assert.equal(staticReadiness(config, "confluence").status, "missing-profile");
	// Configured but not live-verified: status `configured`, NOT usable yet (a live connect opens
	// the gate). Unset referenced env is advisory only — an MCP may use CLI/OAuth auth.
	const noEnv = staticReadiness(config, "slack", { env: {} });
	assert.equal(noEnv.status, "configured");
	assert.equal(noEnv.ready, false);
	assert.deepEqual(noEnv.missingEnv?.sort(), ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"]);
	assert.match(noEnv.detail, /CLI\/OAuth/);
	assert.match(noEnv.detail, /live preflight/);
	// CLI-backed MCP with no env refs: still configured (needs a live check), no env advisory.
	const cliConfig: SuperpowersConfig = { profiles: { slack: { servers: ["slack-cli"] } }, servers: { "slack-cli": { command: "company-slack-mcp", args: ["--stdio"] } } };
	const cli = staticReadiness(cliConfig, "slack", { env: {} });
	assert.equal(cli.status, "configured");
	assert.equal(cli.ready, false);
	assert.equal(cli.missingEnv, undefined);
});

test("missing-server when a profile references an undefined or disabled server", () => {
	const broken: SuperpowersConfig = { profiles: { slack: { servers: ["ghost"] } }, servers: {} };
	assert.equal(staticReadiness(broken, "slack").status, "missing-server");
	const disabled: SuperpowersConfig = { profiles: { slack: { servers: ["slack"] } }, servers: { slack: { command: "x", disabled: true } } };
	assert.equal(staticReadiness(disabled, "slack").status, "missing-server");
});

test("gate helpers reflect readiness and confirmation", () => {
	const report: ReadinessReport = {
		updatedAt: "t",
		configPath: "/x",
		sources: [
			{ source: "repo", profile: "repo", ready: true, status: "ready", detail: "built-in" },
			{ source: "slack", profile: "slack", ready: false, status: "connect-failed", detail: "live MCP connect failed" },
		],
	};
	assert.equal(isConfirmed(report), false);
	assert.equal(sourceUsable(report, "repo"), true);
	assert.equal(sourceUsable(report, "slack"), false);
	assert.deepEqual(unmetSources(report).map((s) => s.source), ["slack"]);

	report.sources[1]!.skipped = true;
	assert.deepEqual(unmetSources(report), []);
	assert.equal(sourceUsable(report, "slack"), false);
	report.confirmedAt = "now";
	assert.equal(isConfirmed(report), true);
});
