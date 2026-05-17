import { readFile } from "node:fs/promises";
import path from "node:path";
import { MANIFEST_FILE_NAME } from "./manifest.ts";

const GIST_ID_PATTERN = /^[0-9a-f]{20,40}$/i;
const GIST_HTML_HOST = "gist.github.com";
const GIST_RAW_HOST = "gist.githubusercontent.com";
const GITHUB_API_HOST = "api.github.com";

export interface ProfileSource {
	kind: "gist" | "local";
	displayUrl: string;
	gistId?: string;
	version?: string;
}

export interface FetchedManifest {
	source: ProfileSource;
	manifestText: string;
	files: Map<string, string>;
}

export interface ParsedGistUrl {
	gistId: string;
	requestedFile?: string;
	versionInUrl?: string;
}

export class SourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SourceError";
	}
}

export function parseGistReference(input: string): ParsedGistUrl {
	const value = input.trim();
	if (!value) throw new SourceError("Source URL or id is required");
	if (GIST_ID_PATTERN.test(value)) return { gistId: value.toLowerCase() };
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new SourceError(`Could not parse source as a URL or gist id: ${value}`);
	}
	if (url.host === GIST_HTML_HOST) {
		const id = extractGistId(url.pathname.split("/").filter(Boolean).at(-1));
		return { gistId: id };
	}
	if (url.host === GIST_RAW_HOST) {
		const parts = url.pathname.split("/").filter(Boolean);
		const idIndex = parts.findIndex((part) => GIST_ID_PATTERN.test(part));
		if (idIndex < 0) throw new SourceError(`Could not find a gist id in raw URL: ${value}`);
		const gistId = parts[idIndex]!.toLowerCase();
		const after = parts.slice(idIndex + 1);
		const versionIndex = after.findIndex((part, index) => index === 0 && part === "raw") + 1;
		const next = after[versionIndex === 0 ? 0 : versionIndex];
		const looksLikeSha = next && /^[0-9a-f]{40}$/i.test(next);
		const versionInUrl = looksLikeSha ? next.toLowerCase() : undefined;
		const fileNameIndex = looksLikeSha ? versionIndex + 1 : versionIndex;
		const requestedFile = after[fileNameIndex];
		return { gistId, requestedFile, versionInUrl };
	}
	throw new SourceError(`Unsupported source URL host: ${url.host}`);
}

export async function fetchProfileSource(input: string, options: { token?: string; fetchImpl?: typeof fetch } = {}): Promise<FetchedManifest> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const token = options.token ?? process.env.PI_PROFILE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? undefined;
	const parsed = parseGistReference(input);
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "pi-profile",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const url = `https://${GITHUB_API_HOST}/gists/${parsed.gistId}`;
	const response = await fetchImpl(url, { headers });
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new SourceError(`GitHub gist API returned ${response.status} for ${url}${detail ? `: ${truncate(detail, 200)}` : ""}`);
	}
	const body = (await response.json()) as Record<string, unknown>;
	const files = extractFiles(body.files);
	const manifestName = parsed.requestedFile ?? MANIFEST_FILE_NAME;
	const manifestText = files.get(manifestName);
	if (manifestText === undefined) {
		throw new SourceError(`Gist ${parsed.gistId} does not contain ${manifestName}. Files present: ${[...files.keys()].join(", ") || "(none)"}`);
	}
	return {
		source: {
			kind: "gist",
			displayUrl: `https://${GIST_HTML_HOST}/${parsed.gistId}`,
			gistId: parsed.gistId,
			version: parsed.versionInUrl ?? extractLatestVersion(body),
		},
		manifestText,
		files,
	};
}

export async function loadLocalManifest(filePath: string): Promise<FetchedManifest> {
	const resolved = path.resolve(filePath);
	const text = await readFile(resolved, "utf8");
	const files = new Map<string, string>();
	files.set(path.basename(resolved), text);
	return {
		source: { kind: "local", displayUrl: resolved },
		manifestText: text,
		files,
	};
}

export async function loadLocalManifestDirectory(filePath: string): Promise<FetchedManifest> {
	const resolved = path.resolve(filePath);
	const text = await readFile(resolved, "utf8");
	const files = new Map<string, string>();
	files.set(MANIFEST_FILE_NAME, text);
	const dir = path.dirname(resolved);
	const { readdir } = await import("node:fs/promises");
	let entries: string[] = [];
	try {
		entries = await readdir(dir);
	} catch {
		entries = [];
	}
	for (const entry of entries) {
		if (entry === path.basename(resolved)) continue;
		try {
			const content = await readFile(path.join(dir, entry), "utf8");
			files.set(entry, content);
		} catch {
			// skip directories and unreadable files
		}
	}
	return {
		source: { kind: "local", displayUrl: resolved },
		manifestText: text,
		files,
	};
}

function extractFiles(value: unknown): Map<string, string> {
	const files = new Map<string, string>();
	if (!isRecord(value)) return files;
	for (const [name, entry] of Object.entries(value)) {
		if (!isRecord(entry)) continue;
		const content = entry.content;
		const truncated = entry.truncated === true;
		const rawUrl = typeof entry.raw_url === "string" ? entry.raw_url : undefined;
		if (typeof content === "string" && !truncated) files.set(name, content);
		else if (rawUrl) files.set(name, `__pi_profile_pending_raw__:${rawUrl}`);
	}
	return files;
}

export async function materializePendingFiles(files: Map<string, string>, options: { token?: string; fetchImpl?: typeof fetch } = {}): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const token = options.token ?? process.env.PI_PROFILE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? undefined;
	const headers: Record<string, string> = { "User-Agent": "pi-profile" };
	if (token) headers.Authorization = `Bearer ${token}`;
	for (const [name, value] of files) {
		if (!value.startsWith("__pi_profile_pending_raw__:")) continue;
		const rawUrl = value.slice("__pi_profile_pending_raw__:".length);
		const response = await fetchImpl(rawUrl, { headers });
		if (!response.ok) throw new SourceError(`Could not fetch raw gist file ${name} from ${rawUrl}: ${response.status}`);
		files.set(name, await response.text());
	}
}

function extractLatestVersion(body: Record<string, unknown>): string | undefined {
	const history = body.history;
	if (!Array.isArray(history) || history.length === 0) return undefined;
	const entry = history[0];
	if (!isRecord(entry)) return undefined;
	const version = entry.version;
	return typeof version === "string" ? version : undefined;
}

function extractGistId(slug: string | undefined): string {
	if (!slug) throw new SourceError("Gist URL is missing an id");
	const id = slug.includes("/") ? slug.split("/").at(-1) ?? "" : slug;
	if (!GIST_ID_PATTERN.test(id)) throw new SourceError(`Gist URL does not contain a valid id: ${slug}`);
	return id.toLowerCase();
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
