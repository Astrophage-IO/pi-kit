#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyManifest } from "../src/apply.ts";
import { computeDrift, formatDrift } from "../src/diff.ts";
import {
	ManifestError,
	parseManifest,
	resolveManifest,
	type Manifest,
} from "../src/manifest.ts";
import {
	SourceError,
	fetchProfileSource,
	loadLocalManifestDirectory,
	materializePendingFiles,
	type FetchedManifest,
} from "../src/source.ts";
import {
	DEFAULT_SECRETS_FILE,
	readState,
	resolveStateFile,
} from "../src/state.ts";

interface ParsedArgs {
	command: string;
	positional: string[];
	flags: Record<string, string | boolean>;
}

function usage(): void {
	const lines = [
		"Usage: pi-profile <command> [options]",
		"",
		"Commands:",
		"  init <gist-url|id|local-path>   Save the source and apply it now.",
		"  sync                            Re-fetch the saved source and apply.",
		"  diff [path]                     Show drift without writing. Optional local manifest path.",
		"  apply <path>                    Apply a local manifest file (skip fetch).",
		"  status                          Show URL, pinned version, last sync, current drift.",
		"  secrets                         List required/optional secrets and which are missing.",
		"  push                            Write current state back to the gist (requires gh).",
		"",
		"Common options:",
		"  --state-file <path>             Override state file (default: ~/.pi/profile/state.json).",
		"  --settings-file <path>          Override pi settings file (default: ~/.pi/agent/settings.json).",
		"  --host <name>                   Override hostname for host overlay (or set PI_PROFILE_HOST).",
		"  --token <token>                 GitHub token for secret gists (or set GITHUB_TOKEN).",
		"  --pi <bin>                      pi binary to invoke (default: pi).",
		"  --dry-run                       Compute drift but do not write.",
		"  -h, --help                      Show this help.",
		"  --version                       Print version.",
	];
	console.log(lines.join("\n"));
}

async function version(): Promise<string> {
	const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version?: string };
	return pkg.version ?? "0.0.0";
}

function parseArgs(argv: string[]): ParsedArgs {
	const [command = "", ...rest] = argv;
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i]!;
		if (token === "--") {
			positional.push(...rest.slice(i + 1));
			break;
		}
		if (token.startsWith("--")) {
			const equalIndex = token.indexOf("=");
			const key = equalIndex >= 0 ? token.slice(2, equalIndex) : token.slice(2);
			if (equalIndex >= 0) {
				flags[key] = token.slice(equalIndex + 1);
			} else if (key === "dry-run" || key === "help") {
				flags[key] = true;
			} else {
				const next = rest[i + 1];
				if (next === undefined || next.startsWith("--")) {
					flags[key] = true;
				} else {
					flags[key] = next;
					i++;
				}
			}
		} else if (token === "-h") {
			flags.help = true;
		} else {
			positional.push(token);
		}
	}
	return { command, positional, flags };
}

function readStringFlag(flags: ParsedArgs["flags"], name: string): string | undefined {
	const value = flags[name];
	if (typeof value === "string" && value.length > 0) return value;
	return undefined;
}

async function loadSecretsFile(): Promise<void> {
	const target = process.env.PI_PROFILE_SECRETS_FILE ?? DEFAULT_SECRETS_FILE;
	if (!existsSync(target)) return;
	try {
		const text = await readFile(target, "utf8");
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const equalIndex = line.indexOf("=");
			if (equalIndex < 0) continue;
			const key = line.slice(0, equalIndex).trim();
			const value = stripQuotes(line.slice(equalIndex + 1).trim());
			if (!key) continue;
			if (process.env[key] === undefined) process.env[key] = value;
		}
	} catch {
		// secrets file is best-effort; missing/unreadable is fine
	}
}

function stripQuotes(value: string): string {
	if (value.length >= 2 && (value.startsWith("\"") || value.startsWith("'")) && value.endsWith(value[0]!)) {
		return value.slice(1, -1);
	}
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

async function commandInit(args: ParsedArgs): Promise<void> {
	const sourceInput = args.positional[0];
	if (!sourceInput) throw new Error("Usage: pi-profile init <gist-url|id|local-path>");
	await loadSecretsFile();
	const token = readStringFlag(args.flags, "token");
	const fetched = await resolveSource(sourceInput, token);
	const manifest = resolveManifestWithHost(parseManifest(JSON.parse(fetched.manifestText)), readStringFlag(args.flags, "host"));
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
		dryRun: Boolean(args.flags["dry-run"]),
		piBin: readStringFlag(args.flags, "pi"),
		settingsFile: readStringFlag(args.flags, "settings-file"),
		stateFile: readStringFlag(args.flags, "state-file"),
		logger: (line) => process.stderr.write(`[pi-profile] ${line}\n`),
	});
	printResult(result.drift, result.dryRun);
}

async function commandSync(args: ParsedArgs): Promise<void> {
	await loadSecretsFile();
	const state = await readState({ stateFile: readStringFlag(args.flags, "state-file") });
	if (!state?.sourceUrl) throw new Error("No saved profile source. Run `pi-profile init <url>` first.");
	const token = readStringFlag(args.flags, "token");
	const fetched = await resolveSource(state.sourceUrl, token);
	const manifest = resolveManifestWithHost(parseManifest(JSON.parse(fetched.manifestText)), readStringFlag(args.flags, "host"));
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
		dryRun: Boolean(args.flags["dry-run"]),
		piBin: readStringFlag(args.flags, "pi"),
		settingsFile: readStringFlag(args.flags, "settings-file"),
		stateFile: readStringFlag(args.flags, "state-file"),
		logger: (line) => process.stderr.write(`[pi-profile] ${line}\n`),
	});
	printResult(result.drift, result.dryRun);
}

async function commandDiff(args: ParsedArgs): Promise<void> {
	await loadSecretsFile();
	const sourceInput = args.positional[0];
	const stateFile = readStringFlag(args.flags, "state-file");
	const settingsFile = readStringFlag(args.flags, "settings-file");
	let fetched: FetchedManifest;
	if (sourceInput) {
		fetched = await resolveSource(sourceInput, readStringFlag(args.flags, "token"));
	} else {
		const state = await readState({ stateFile });
		if (!state?.sourceUrl) throw new Error("No saved profile source. Pass a path or run `pi-profile init <url>` first.");
		fetched = await resolveSource(state.sourceUrl, readStringFlag(args.flags, "token"));
	}
	const manifest = resolveManifestWithHost(parseManifest(JSON.parse(fetched.manifestText)), readStringFlag(args.flags, "host"));
	const state = await readState({ stateFile });
	const currentSettings = await readSettingsFile(settingsFile);
	const currentFileContents = await readFileMap(manifest.files.map((file) => expandHome(file.target)));
	const drift = computeDrift({
		manifest,
		currentSettings,
		currentFileContents,
		currentEnv: process.env,
		state,
		gistFiles: fetched.files,
	});
	console.log(formatDrift(drift));
}

async function commandApply(args: ParsedArgs): Promise<void> {
	const target = args.positional[0];
	if (!target) throw new Error("Usage: pi-profile apply <path>");
	await loadSecretsFile();
	const fetched = await loadLocalManifestDirectory(target);
	const manifest = resolveManifestWithHost(parseManifest(JSON.parse(fetched.manifestText)), readStringFlag(args.flags, "host"));
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
		dryRun: Boolean(args.flags["dry-run"]),
		piBin: readStringFlag(args.flags, "pi"),
		settingsFile: readStringFlag(args.flags, "settings-file"),
		stateFile: readStringFlag(args.flags, "state-file"),
		logger: (line) => process.stderr.write(`[pi-profile] ${line}\n`),
	});
	printResult(result.drift, result.dryRun);
}

async function commandStatus(args: ParsedArgs): Promise<void> {
	const stateFile = readStringFlag(args.flags, "state-file") ?? resolveStateFile();
	const state = await readState({ stateFile });
	if (!state) {
		console.log("No profile state at " + stateFile + ". Run `pi-profile init <url>` to bootstrap.");
		return;
	}
	console.log(JSON.stringify({
		stateFile,
		sourceUrl: state.sourceUrl,
		sourceKind: state.sourceKind,
		gistId: state.gistId,
		pinnedVersion: state.pinnedVersion,
		lastSyncedAt: state.lastSyncedAt,
		manifestSha256: state.manifestSha256,
		ownedPackages: state.ownedPackages,
		ownedSettings: state.ownedSettings.map((entry) => entry.key),
		ownedFiles: state.ownedFiles.map((entry) => entry.target),
	}, null, 2));
}

async function commandSecrets(args: ParsedArgs): Promise<void> {
	await loadSecretsFile();
	const stateFile = readStringFlag(args.flags, "state-file");
	const state = await readState({ stateFile });
	if (!state?.sourceUrl) {
		console.log("No saved profile source. Run `pi-profile init <url>` first.");
		return;
	}
	const fetched = await resolveSource(state.sourceUrl, readStringFlag(args.flags, "token"));
	const manifest = resolveManifestWithHost(parseManifest(JSON.parse(fetched.manifestText)), readStringFlag(args.flags, "host"));
	const required = manifest.secrets.required ?? [];
	const optional = manifest.secrets.optional ?? [];
	const missingRequired = required.filter((key) => !process.env[key]);
	const missingOptional = optional.filter((key) => !process.env[key]);
	console.log(JSON.stringify({
		required,
		optional,
		missingRequired,
		missingOptional,
		secretsFile: process.env.PI_PROFILE_SECRETS_FILE ?? DEFAULT_SECRETS_FILE,
	}, null, 2));
	if (missingRequired.length > 0) process.exitCode = 1;
}

async function commandPush(_args: ParsedArgs): Promise<void> {
	const message = [
		"`pi-profile push` is not yet implemented.",
		"Edit your gist directly (https://gist.github.com) or pipe the desired manifest with:",
		"  cat pi-profile.json | gh gist edit <gist-id> -",
	].join("\n");
	process.stderr.write(`${message}\n`);
	process.exitCode = 2;
}

function resolveManifestWithHost(manifest: Manifest, hostOverride: string | undefined): Manifest {
	return resolveManifest(manifest, hostOverride ? { hostname: hostOverride } : {});
}

function printResult(drift: ReturnType<typeof computeDrift>, dryRun: boolean): void {
	const prefix = dryRun ? "[dry-run] " : "";
	console.log(`${prefix}${formatDrift(drift)}`);
}

async function readSettingsFile(settingsFile: string | undefined): Promise<Record<string, unknown>> {
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

async function readFileMap(targets: string[]): Promise<Record<string, string | undefined>> {
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

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

async function main(argv: string[]): Promise<void> {
	if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
		usage();
		return;
	}
	if (argv[0] === "--version") {
		console.log(await version());
		return;
	}
	const parsed = parseArgs(argv);
	if (parsed.flags.help) {
		usage();
		return;
	}
	switch (parsed.command) {
		case "init":
			return commandInit(parsed);
		case "sync":
			return commandSync(parsed);
		case "diff":
			return commandDiff(parsed);
		case "apply":
			return commandApply(parsed);
		case "status":
			return commandStatus(parsed);
		case "secrets":
			return commandSecrets(parsed);
		case "push":
			return commandPush(parsed);
		default:
			throw new Error(`Unknown command: ${parsed.command || "(missing)"}`);
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	const message = error instanceof ManifestError || error instanceof SourceError
		? error.message
		: error instanceof Error ? error.message : String(error);
	process.stderr.write(`pi-profile: ${message}\n`);
	process.stderr.write("Run `pi-profile --help` for usage.\n");
	process.exit(1);
});
