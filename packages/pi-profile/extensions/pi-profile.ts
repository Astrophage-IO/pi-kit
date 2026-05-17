import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { applyManifest } from "../src/apply.ts";
import { computeDrift, formatDrift } from "../src/diff.ts";
import { parseManifest, resolveManifest } from "../src/manifest.ts";
import {
	fetchProfileSource,
	loadLocalManifestDirectory,
	materializePendingFiles,
	type FetchedManifest,
} from "../src/source.ts";
import { DEFAULT_STATE_FILE, readState, resolveStateFile } from "../src/state.ts";

function flagString(pi: ExtensionAPI, name: string, fallback = ""): string {
	const value = pi.getFlag(name);
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

async function resolveSource(input: string, token: string | undefined): Promise<FetchedManifest> {
	if (input.startsWith(".") || input.startsWith("/") || input.startsWith("~")) {
		const resolved = input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : path.resolve(input);
		return loadLocalManifestDirectory(resolved);
	}
	const fetched = await fetchProfileSource(input, { token });
	await materializePendingFiles(fetched.files, { token });
	return fetched;
}

async function readPiSettings(settingsFile: string | undefined): Promise<Record<string, unknown>> {
	const target = settingsFile ?? path.join(os.homedir(), ".pi", "agent", "settings.json");
	try {
		const text = await readFile(target, "utf8");
		const parsed = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

async function readFileContents(targets: string[]): Promise<Record<string, string | undefined>> {
	const out: Record<string, string | undefined> = {};
	await Promise.all(targets.map(async (target) => {
		try {
			out[target] = await readFile(target, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") out[target] = undefined;
			else throw error;
		}
	}));
	return out;
}

export default function piProfileExtension(pi: ExtensionAPI) {
	pi.registerFlag("profile-state-file", {
		description: "Override pi-profile state file (default: ~/.pi/profile/state.json).",
		type: "string",
		default: process.env.PI_PROFILE_STATE_FILE ?? DEFAULT_STATE_FILE,
	});
	pi.registerFlag("profile-source", {
		description: "Override the saved profile source URL/path for this session.",
		type: "string",
		default: process.env.PI_PROFILE_SOURCE ?? "",
	});
	pi.registerFlag("profile-token", {
		description: "GitHub token for secret-gist access (or set PI_PROFILE_GITHUB_TOKEN / GITHUB_TOKEN).",
		type: "string",
		default: process.env.PI_PROFILE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? "",
	});

	async function loadCurrentManifest(): Promise<{ fetched: FetchedManifest; manifest: ReturnType<typeof parseManifest> }> {
		const override = flagString(pi, "profile-source", "");
		const stateFile = flagString(pi, "profile-state-file", DEFAULT_STATE_FILE);
		let sourceInput = override;
		if (!sourceInput) {
			const state = await readState({ stateFile });
			if (!state?.sourceUrl) throw new Error("No saved profile source. Run `pi-profile init <url>` outside of pi first, or pass --profile-source.");
			sourceInput = state.sourceUrl;
		}
		const token = flagString(pi, "profile-token", "") || undefined;
		const fetched = await resolveSource(sourceInput, token);
		const manifest = resolveManifest(parseManifest(JSON.parse(fetched.manifestText)));
		return { fetched, manifest };
	}

	pi.registerCommand("profile-status", {
		description: "Show pi-profile source, last sync, and current drift.",
		handler: async (_args, ctx) => {
			const stateFile = flagString(pi, "profile-state-file", DEFAULT_STATE_FILE);
			const state = await readState({ stateFile });
			if (!state) {
				ctx.ui.notify(`No pi-profile state at ${stateFile}. Run \`pi-profile init <url>\` to bootstrap.`, "info");
				return;
			}
			const lines = [
				`Source: ${state.sourceUrl}`,
				`Last sync: ${state.lastSyncedAt}`,
				state.pinnedVersion ? `Pinned: ${state.pinnedVersion}` : `Pinned: (none)`,
				`Owned packages: ${state.ownedPackages.length}`,
				`Owned settings keys: ${state.ownedSettings.length}`,
				`Owned files: ${state.ownedFiles.length}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("profile-diff", {
		description: "Fetch the saved profile and show drift without writing.",
		handler: async (_args, ctx) => {
			const { fetched, manifest } = await loadCurrentManifest();
			const stateFile = flagString(pi, "profile-state-file", DEFAULT_STATE_FILE);
			const state = await readState({ stateFile });
			const currentSettings = await readPiSettings(undefined);
			const currentFileContents = await readFileContents(manifest.files.map((file) => expandHome(file.target)));
			const drift = computeDrift({
				manifest,
				currentSettings,
				currentFileContents,
				currentEnv: process.env,
				state,
				gistFiles: fetched.files,
			});
			ctx.ui.notify(formatDrift(drift), "info");
		},
	});

	pi.registerCommand("profile-sync", {
		description: "Fetch the saved profile and apply (install/remove packages, write files, merge settings).",
		handler: async (_args, ctx) => {
			const { fetched, manifest } = await loadCurrentManifest();
			const stateFile = flagString(pi, "profile-state-file", DEFAULT_STATE_FILE);
			const result = await applyManifest({
				manifest,
				gistFiles: fetched.files,
				source: {
					url: fetched.source.displayUrl,
					kind: fetched.source.kind,
					gistId: fetched.source.gistId,
					version: fetched.source.version,
				},
				manifestText: fetched.manifestText,
				stateFile,
				logger: (line) => ctx.ui.notify(`pi-profile: ${line}`, "info"),
			});
			ctx.ui.notify(formatDrift(result.drift), "info");
		},
	});

	pi.registerTool({
		name: "profile_status",
		label: "Profile Status",
		description: "Show pi-profile sync state (saved source, last sync, owned packages/files/settings).",
		promptSnippet: "Show pi-profile sync state",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params) {
			const stateFile = flagString(pi, "profile-state-file", DEFAULT_STATE_FILE);
			const state = await readState({ stateFile });
			const text = state ? JSON.stringify(state, null, 2) : `No pi-profile state at ${stateFile}.`;
			return {
				content: [{ type: "text", text }],
				details: { stateFile, state: state ?? null },
			};
		},
	});

	pi.registerTool({
		name: "profile_diff",
		label: "Profile Diff",
		description: "Fetch the saved pi-profile source and report drift between it and this machine's current pi state. Read-only.",
		promptSnippet: "Diff this machine against the saved pi-profile",
		promptGuidelines: [
			"Use profile_diff to check whether this machine is up to date with the user's portable pi-profile.",
			"Surface required missing secrets in plain language; do not propose fixes that involve writing tokens to the manifest.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const { fetched, manifest } = await loadCurrentManifest();
			const stateFile = flagString(pi, "profile-state-file", DEFAULT_STATE_FILE);
			const state = await readState({ stateFile });
			const currentSettings = await readPiSettings(undefined);
			const currentFileContents = await readFileContents(manifest.files.map((file) => expandHome(file.target)));
			const drift = computeDrift({
				manifest,
				currentSettings,
				currentFileContents,
				currentEnv: process.env,
				state,
				gistFiles: fetched.files,
			});
			return {
				content: [{ type: "text", text: formatDrift(drift) }],
				details: drift,
			};
		},
	});

	pi.registerTool({
		name: "profile_sync",
		label: "Profile Sync",
		description: "Fetch and apply the saved pi-profile. Installs/removes pi packages, writes managed files, and merges owned settings keys.",
		promptSnippet: "Apply the saved pi-profile to this machine",
		promptGuidelines: [
			"Call profile_sync after the user has explicitly asked to bring this machine up to date with their pi-profile.",
			"Prefer profile_diff first to show what will change; only call profile_sync when the user accepts the changes.",
		],
		parameters: Type.Object({
			dryRun: Type.Optional(Type.Boolean({ description: "Compute drift but do not write. Default: false." })),
		}),
		async execute(_toolCallId, params) {
			const { fetched, manifest } = await loadCurrentManifest();
			const stateFile = flagString(pi, "profile-state-file", DEFAULT_STATE_FILE);
			const result = await applyManifest({
				manifest,
				gistFiles: fetched.files,
				source: {
					url: fetched.source.displayUrl,
					kind: fetched.source.kind,
					gistId: fetched.source.gistId,
					version: fetched.source.version,
				},
				manifestText: fetched.manifestText,
				stateFile,
				dryRun: params.dryRun === true,
			});
			return {
				content: [{ type: "text", text: formatDrift(result.drift) }],
				details: { dryRun: result.dryRun, drift: result.drift, state: result.state },
			};
		},
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const stateFile = flagString(pi, "profile-state-file", DEFAULT_STATE_FILE);
		const state = await readState({ stateFile });
		if (state?.sourceUrl) ctx.ui.setStatus("pi-profile", `profile: ${path.basename(state.sourceUrl)}`);
	});
}

export { resolveStateFile };
