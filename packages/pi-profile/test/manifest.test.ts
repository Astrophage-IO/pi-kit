import assert from "node:assert/strict";
import { test } from "bun:test";
import {
	MANIFEST_API_VERSION,
	ManifestError,
	listFilesReferenced,
	packageSourceId,
	parseManifest,
	resolveManifest,
} from "../src/manifest.ts";

test("parseManifest accepts a minimal manifest and fills defaults", () => {
	const manifest = parseManifest({ apiVersion: MANIFEST_API_VERSION });
	assert.equal(manifest.apiVersion, MANIFEST_API_VERSION);
	assert.deepEqual(manifest.packages, []);
	assert.deepEqual(manifest.settings, {});
	assert.deepEqual(manifest.env, {});
	assert.deepEqual(manifest.files, []);
	assert.deepEqual(manifest.secrets, {});
	assert.deepEqual(manifest.hosts, {});
	assert.deepEqual(manifest.postApply, []);
});

test("parseManifest rejects bad apiVersion", () => {
	assert.throws(() => parseManifest({ apiVersion: "pi-profile/v0" }), ManifestError);
	assert.throws(() => parseManifest({}), ManifestError);
	assert.throws(() => parseManifest("not an object"), ManifestError);
});

test("parseManifest validates package specs (string or { source })", () => {
	const manifest = parseManifest({
		apiVersion: MANIFEST_API_VERSION,
		packages: [
			"@astrophage-io/pi-bus",
			{ source: "@vendor/foo@^1.2.0", extensions: ["foo"] },
		],
	});
	assert.equal(packageSourceId(manifest.packages[0]!), "@astrophage-io/pi-bus");
	assert.equal(packageSourceId(manifest.packages[1]!), "@vendor/foo@^1.2.0");
	assert.deepEqual((manifest.packages[1] as { extensions?: string[] }).extensions, ["foo"]);
	assert.throws(() => parseManifest({ apiVersion: MANIFEST_API_VERSION, packages: [123] }), ManifestError);
	assert.throws(() => parseManifest({ apiVersion: MANIFEST_API_VERSION, packages: [{ source: "" }] }), ManifestError);
});

test("parseManifest validates env keys must match [A-Z_][A-Z0-9_]*", () => {
	assert.throws(
		() => parseManifest({ apiVersion: MANIFEST_API_VERSION, env: { "lower_case": "x" } }),
		ManifestError,
	);
	assert.throws(
		() => parseManifest({ apiVersion: MANIFEST_API_VERSION, env: { PIBUS_PORT: 7373 } }),
		ManifestError,
	);
	const ok = parseManifest({ apiVersion: MANIFEST_API_VERSION, env: { PIBUS_PORT: "7373" } });
	assert.equal(ok.env.PIBUS_PORT, "7373");
});

test("parseManifest validates files require target and source", () => {
	assert.throws(
		() => parseManifest({ apiVersion: MANIFEST_API_VERSION, files: [{ target: "~/x" }] }),
		ManifestError,
	);
	assert.throws(
		() => parseManifest({ apiVersion: MANIFEST_API_VERSION, files: [{ source: "x" }] }),
		ManifestError,
	);
	const ok = parseManifest({
		apiVersion: MANIFEST_API_VERSION,
		files: [{ target: "~/.pi/agent/superpowers.json", source: "superpowers.json", mode: 0o600 }],
	});
	assert.equal(ok.files[0]?.mode, 0o600);
});

test("resolveManifest applies the host overlay (env, packages, settings, files)", () => {
	const manifest = parseManifest({
		apiVersion: MANIFEST_API_VERSION,
		packages: ["base-pkg"],
		settings: { defaultModel: "claude-sonnet-4-5" },
		env: { PIBUS_PUSH: "targeted" },
		files: [{ target: "~/a.txt", source: "a.txt" }],
		hosts: {
			homelab: {
				packages: ["homelab-only"],
				settings: { defaultModel: "claude-opus" },
				env: { PIBUS_HOST: "10.0.0.5" },
				files: [{ target: "~/a.txt", source: "a-homelab.txt" }, { target: "~/b.txt", source: "b.txt" }],
			},
		},
	});
	const resolved = resolveManifest(manifest, { hostname: "homelab" });
	assert.deepEqual(resolved.packages.map(packageSourceId), ["base-pkg", "homelab-only"]);
	assert.equal(resolved.settings.defaultModel, "claude-opus");
	assert.equal(resolved.env.PIBUS_HOST, "10.0.0.5");
	assert.equal(resolved.env.PIBUS_PUSH, "targeted");
	const files = new Map(resolved.files.map((file) => [file.target, file.source] as const));
	assert.equal(files.get("~/a.txt"), "a-homelab.txt");
	assert.equal(files.get("~/b.txt"), "b.txt");
});

test("resolveManifest is a no-op when the hostname has no overlay", () => {
	const manifest = parseManifest({
		apiVersion: MANIFEST_API_VERSION,
		packages: ["base"],
		hosts: { homelab: { packages: ["homelab"] } },
	});
	const resolved = resolveManifest(manifest, { hostname: "laptop" });
	assert.deepEqual(resolved.packages.map(packageSourceId), ["base"]);
});

test("listFilesReferenced includes both base and host overlay file sources", () => {
	const manifest = parseManifest({
		apiVersion: MANIFEST_API_VERSION,
		files: [{ target: "~/a.txt", source: "a.txt" }],
		hosts: { homelab: { files: [{ target: "~/b.txt", source: "b.txt" }] } },
	});
	assert.deepEqual(new Set(listFilesReferenced(manifest)), new Set(["a.txt", "b.txt"]));
});
