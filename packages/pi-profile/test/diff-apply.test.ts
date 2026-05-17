import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { applyManifest, type PiInstaller } from "../src/apply.ts";
import { computeDrift, formatDrift } from "../src/diff.ts";
import { MANIFEST_API_VERSION, parseManifest, type Manifest } from "../src/manifest.ts";
import { hashManifest, readState, type ProfileState } from "../src/state.ts";

function tempDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "pi-profile-apply-test-"));
}

function buildManifest(overrides: Partial<Manifest> & { apiVersion?: typeof MANIFEST_API_VERSION } = {}): Manifest {
	const base: Record<string, unknown> = {
		apiVersion: MANIFEST_API_VERSION,
		packages: overrides.packages,
		settings: overrides.settings,
		env: overrides.env,
		files: overrides.files,
		secrets: overrides.secrets,
		hosts: overrides.hosts,
		postApply: overrides.postApply,
	};
	for (const key of Object.keys(base)) if (base[key] === undefined) delete base[key];
	return parseManifest(base);
}

function recordingInstaller(): { calls: Array<{ action: string; source: string }>; installer: PiInstaller } {
	const calls: Array<{ action: string; source: string }> = [];
	const installer: PiInstaller = async (action, source) => {
		calls.push({ action, source });
	};
	return { calls, installer };
}

test("computeDrift detects added packages, settings changes, file create/update, and env advisories", () => {
	const manifest = buildManifest({
		packages: ["@x/y", "@x/z"],
		settings: { defaultModel: "claude-sonnet-4-5", theme: "tokyonight" },
		env: { PIBUS_PUSH: "targeted" },
		files: [{ target: "/tmp/example/a.txt", source: "a.txt" }],
		secrets: { required: ["MUST_BE_SET"], optional: ["NICE_TO_HAVE"] },
	});
	const gistFiles = new Map<string, string>([["a.txt", "hello"]]);
	const drift = computeDrift({
		manifest,
		currentSettings: { defaultModel: "claude-haiku" },
		currentFileContents: { "/tmp/example/a.txt": undefined },
		currentEnv: {},
		state: undefined,
		gistFiles,
	});
	const sources = new Set(drift.packages.map((change) => `${change.kind}:${change.source}`));
	assert.ok(sources.has("add:@x/y"));
	assert.ok(sources.has("add:@x/z"));
	const settingsByKey = new Map(drift.settings.map((change) => [change.key, change]));
	assert.equal(settingsByKey.get("defaultModel")?.kind, "change");
	assert.equal(settingsByKey.get("theme")?.kind, "set");
	assert.equal(drift.files[0]?.kind, "create");
	assert.deepEqual(drift.env, [{ key: "PIBUS_PUSH", value: "targeted" }]);
	assert.deepEqual(drift.missingRequiredSecrets, ["MUST_BE_SET"]);
	assert.deepEqual(drift.missingOptionalSecrets, ["NICE_TO_HAVE"]);
	assert.equal(drift.clean, false);
	const formatted = formatDrift(drift);
	assert.match(formatted, /Missing required secrets/);
});

test("computeDrift detects packages that the profile owns but the manifest no longer wants", () => {
	const manifest = buildManifest({ packages: ["@x/y"] });
	const state: ProfileState = {
		apiVersion: "pi-profile-state/v1",
		sourceUrl: "https://gist.github.com/manash/abc",
		sourceKind: "gist",
		lastSyncedAt: new Date().toISOString(),
		manifestSha256: "",
		ownedPackages: ["@x/y", "@old/dropped"],
		ownedSettings: [],
		ownedFiles: [],
	};
	const drift = computeDrift({
		manifest,
		currentSettings: {},
		currentFileContents: {},
		currentEnv: {},
		state,
		gistFiles: new Map(),
	});
	assert.deepEqual(
		drift.packages.map((change) => `${change.kind}:${change.source}`).sort(),
		["remove:@old/dropped"],
	);
});

test("applyManifest installs missing packages, writes managed files, and merges owned settings", async () => {
	const dir = tempDir();
	try {
		process.env.MUST_BE_SET = "value";
		const stateFile = path.join(dir, "state.json");
		const settingsFile = path.join(dir, "pi-settings.json");
		writeFileSync(settingsFile, JSON.stringify({ existing: "keep me", defaultModel: "claude-haiku" }), "utf8");
		const fileTarget = path.join(dir, "managed.json");
		const manifest = buildManifest({
			packages: ["@astrophage-io/pi-bus"],
			settings: { defaultModel: "claude-sonnet-4-5", theme: "tokyonight" },
			files: [{ target: fileTarget, source: "managed.json" }],
			secrets: { required: ["MUST_BE_SET"] },
		});
		const gistFiles = new Map([["managed.json", "{\"key\":\"value\"}"]]);
		const { calls, installer } = recordingInstaller();
		const result = await applyManifest({
			manifest,
			gistFiles,
			source: { url: "https://gist.github.com/manash/abc", kind: "gist", gistId: "abc" },
			manifestText: JSON.stringify(manifest),
			settingsFile,
			stateFile,
			piInstaller: installer,
			logger: () => {},
		});
		assert.equal(result.dryRun, false);
		assert.deepEqual(calls, [{ action: "install", source: "@astrophage-io/pi-bus" }]);
		const writtenSettings = JSON.parse(readFileSync(settingsFile, "utf8"));
		assert.equal(writtenSettings.existing, "keep me");
		assert.equal(writtenSettings.defaultModel, "claude-sonnet-4-5");
		assert.equal(writtenSettings.theme, "tokyonight");
		assert.equal(readFileSync(fileTarget, "utf8"), "{\"key\":\"value\"}");
		const state = await readState({ stateFile });
		assert.ok(state);
		assert.deepEqual(state?.ownedPackages, ["@astrophage-io/pi-bus"]);
		assert.equal(state?.manifestSha256, hashManifest(JSON.stringify(manifest)));
		const ownedKeys = state?.ownedSettings.map((entry) => entry.key) ?? [];
		assert.deepEqual(ownedKeys.sort(), ["defaultModel", "theme"]);
	} finally {
		delete process.env.MUST_BE_SET;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("applyManifest restores previous settings and removes managed files when manifest drops them", async () => {
	const dir = tempDir();
	try {
		const stateFile = path.join(dir, "state.json");
		const settingsFile = path.join(dir, "pi-settings.json");
		writeFileSync(settingsFile, JSON.stringify({ existing: "keep me", defaultModel: "claude-haiku" }), "utf8");
		const fileTarget = path.join(dir, "managed.json");

		const firstManifest = buildManifest({
			packages: ["@astrophage-io/pi-bus"],
			settings: { defaultModel: "claude-sonnet-4-5", theme: "tokyonight" },
			files: [{ target: fileTarget, source: "managed.json" }],
		});
		await applyManifest({
			manifest: firstManifest,
			gistFiles: new Map([["managed.json", "first"]]),
			source: { url: "https://gist.github.com/manash/abc", kind: "gist", gistId: "abc" },
			manifestText: JSON.stringify(firstManifest),
			settingsFile,
			stateFile,
			piInstaller: async () => {},
			logger: () => {},
		});
		assert.ok(existsSync(fileTarget));

		const secondManifest = buildManifest({ packages: [], settings: {} });
		const { calls, installer } = recordingInstaller();
		await applyManifest({
			manifest: secondManifest,
			gistFiles: new Map(),
			source: { url: "https://gist.github.com/manash/abc", kind: "gist", gistId: "abc" },
			manifestText: JSON.stringify(secondManifest),
			settingsFile,
			stateFile,
			piInstaller: installer,
			logger: () => {},
		});
		assert.deepEqual(calls, [{ action: "remove", source: "@astrophage-io/pi-bus" }]);
		const writtenSettings = JSON.parse(readFileSync(settingsFile, "utf8"));
		assert.equal(writtenSettings.existing, "keep me");
		assert.equal(writtenSettings.defaultModel, "claude-haiku");
		assert.equal(writtenSettings.theme, undefined);
		assert.equal(existsSync(fileTarget), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("applyManifest with dryRun does not mutate disk", async () => {
	const dir = tempDir();
	try {
		const stateFile = path.join(dir, "state.json");
		const settingsFile = path.join(dir, "pi-settings.json");
		writeFileSync(settingsFile, JSON.stringify({ existing: "keep me" }), "utf8");
		const manifest = buildManifest({
			packages: ["@x/y"],
			settings: { defaultModel: "claude-sonnet-4-5" },
		});
		const { calls, installer } = recordingInstaller();
		const result = await applyManifest({
			manifest,
			gistFiles: new Map(),
			source: { url: "local", kind: "local" },
			manifestText: JSON.stringify(manifest),
			settingsFile,
			stateFile,
			piInstaller: installer,
			dryRun: true,
			logger: () => {},
		});
		assert.equal(result.dryRun, true);
		assert.deepEqual(calls, []);
		const writtenSettings = JSON.parse(readFileSync(settingsFile, "utf8"));
		assert.deepEqual(writtenSettings, { existing: "keep me" });
		assert.equal(existsSync(stateFile), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("applyManifest fails fast when a required secret is missing", async () => {
	const dir = tempDir();
	try {
		delete process.env.PI_PROFILE_TEST_MUST_SET;
		const manifest = buildManifest({
			secrets: { required: ["PI_PROFILE_TEST_MUST_SET"] },
		});
		await assert.rejects(
			() => applyManifest({
				manifest,
				gistFiles: new Map(),
				source: { url: "local", kind: "local" },
				manifestText: JSON.stringify(manifest),
				settingsFile: path.join(dir, "pi-settings.json"),
				stateFile: path.join(dir, "state.json"),
				piInstaller: async () => {},
				env: {},
				logger: () => {},
			}),
			/Missing required secrets/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
