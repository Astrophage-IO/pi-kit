import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
	SourceError,
	fetchProfileSource,
	loadLocalManifest,
	loadLocalManifestDirectory,
	parseGistReference,
} from "../src/source.ts";
import { MANIFEST_API_VERSION, MANIFEST_FILE_NAME } from "../src/manifest.ts";

function tempDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "pi-profile-source-test-"));
}

test("parseGistReference accepts a bare 32-hex id", () => {
	const id = "a".repeat(32);
	assert.equal(parseGistReference(id).gistId, id);
});

test("parseGistReference accepts a full gist URL", () => {
	const id = "b".repeat(32);
	const parsed = parseGistReference(`https://gist.github.com/manash/${id}`);
	assert.equal(parsed.gistId, id);
	assert.equal(parsed.requestedFile, undefined);
});

test("parseGistReference accepts a raw file URL", () => {
	const id = "c".repeat(32);
	const parsed = parseGistReference(`https://gist.githubusercontent.com/manash/${id}/raw/pi-profile.json`);
	assert.equal(parsed.gistId, id);
});

test("parseGistReference accepts a raw file URL with pinned commit sha", () => {
	const id = "d".repeat(32);
	const sha = "e".repeat(40);
	const parsed = parseGistReference(`https://gist.githubusercontent.com/manash/${id}/raw/${sha}/pi-profile.json`);
	assert.equal(parsed.gistId, id);
	assert.equal(parsed.versionInUrl, sha);
	assert.equal(parsed.requestedFile, "pi-profile.json");
});

test("parseGistReference rejects nonsense", () => {
	assert.throws(() => parseGistReference(""), SourceError);
	assert.throws(() => parseGistReference("not a url"), SourceError);
	assert.throws(() => parseGistReference("https://example.com/foo"), SourceError);
});

test("fetchProfileSource resolves manifest text from a mocked gist API", async () => {
	const gistId = "a".repeat(32);
	const manifestText = JSON.stringify({ apiVersion: MANIFEST_API_VERSION, packages: ["@x/y"] });
	const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();
		assert.equal(url, `https://api.github.com/gists/${gistId}`);
		return new Response(
			JSON.stringify({
				files: {
					[MANIFEST_FILE_NAME]: { content: manifestText, truncated: false },
					"superpowers.json": { content: "{}", truncated: false },
				},
				history: [{ version: "f".repeat(40) }],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};
	const fetched = await fetchProfileSource(gistId, { fetchImpl: mockFetch as unknown as typeof fetch });
	assert.equal(fetched.source.kind, "gist");
	assert.equal(fetched.source.gistId, gistId);
	assert.equal(fetched.source.version, "f".repeat(40));
	assert.equal(fetched.manifestText, manifestText);
	assert.equal(fetched.files.get("superpowers.json"), "{}");
});

test("fetchProfileSource surfaces gist API errors", async () => {
	const mockFetch = async (): Promise<Response> => new Response("not found", { status: 404 });
	await assert.rejects(
		() => fetchProfileSource("a".repeat(32), { fetchImpl: mockFetch as unknown as typeof fetch }),
		SourceError,
	);
});

test("loadLocalManifest and loadLocalManifestDirectory read from disk", async () => {
	const dir = tempDir();
	try {
		const manifestPath = path.join(dir, "pi-profile.json");
		writeFileSync(manifestPath, JSON.stringify({ apiVersion: MANIFEST_API_VERSION }), "utf8");
		writeFileSync(path.join(dir, "superpowers.json"), "{}", "utf8");
		const direct = await loadLocalManifest(manifestPath);
		assert.equal(direct.files.size, 1);
		const directory = await loadLocalManifestDirectory(manifestPath);
		assert.ok(directory.files.has("pi-profile.json"));
		assert.equal(directory.files.get("superpowers.json"), "{}");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
