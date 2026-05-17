import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packageSourceId, type Manifest } from "./manifest.ts";
import {
	emptyState,
	hashManifest,
	readState,
	writeState,
	type OwnedFileSnapshot,
	type OwnedSettingSnapshot,
	type ProfileState,
	type ResolveStatePathOptions,
} from "./state.ts";
import { computeDrift, type DriftReport } from "./diff.ts";

const DEFAULT_PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const DEFAULT_SETTINGS_FILE = path.join(DEFAULT_PI_AGENT_DIR, "settings.json");

export interface ApplyOptions extends ResolveStatePathOptions {
	manifest: Manifest;
	gistFiles: Map<string, string>;
	source: { url: string; kind: "gist" | "local"; gistId?: string; version?: string };
	manifestText: string;
	dryRun?: boolean;
	piBin?: string;
	settingsFile?: string;
	piInstaller?: PiInstaller;
	env?: NodeJS.ProcessEnv;
	logger?: (line: string) => void;
}

export interface ApplyResult {
	drift: DriftReport;
	state: ProfileState;
	dryRun: boolean;
}

export type PiInstaller = (action: "install" | "remove", source: string) => Promise<void>;

export async function applyManifest(options: ApplyOptions): Promise<ApplyResult> {
	const logger = options.logger ?? (() => {});
	const settingsFile = options.settingsFile ?? process.env.PI_PROFILE_SETTINGS_FILE ?? DEFAULT_SETTINGS_FILE;
	const env = options.env ?? process.env;
	const previousState = await readState({ stateFile: options.stateFile });
	const currentSettings = await readSettings(settingsFile);
	const currentFileContents = await readFiles(options.manifest.files.map((file) => expandHome(file.target)));
	const drift = computeDrift({
		manifest: options.manifest,
		currentSettings,
		currentFileContents,
		currentEnv: env,
		state: previousState,
		gistFiles: options.gistFiles,
	});

	if (drift.missingRequiredSecrets.length > 0 && !options.dryRun) {
		throw new ApplyError(
			`Missing required secrets: ${drift.missingRequiredSecrets.join(", ")}. Set them in the environment (or ~/.pi/profile/secrets.env) and rerun.`,
		);
	}

	if (options.dryRun) {
		const state = previousState ?? emptyState(options.source.url, options.source.kind);
		return { drift, state, dryRun: true };
	}

	const installer = options.piInstaller ?? createSpawnInstaller(options.piBin ?? "pi", logger);
	const nextOwnedPackages = new Set(options.manifest.packages.map(packageSourceId));
	const previousOwnedPackages = new Set(previousState?.ownedPackages ?? []);

	for (const change of drift.packages) {
		if (change.kind === "add") {
			logger(`+ pi install ${change.source}`);
			await installer("install", change.source);
		} else if (change.kind === "remove") {
			logger(`- pi remove ${change.source}`);
			await installer("remove", change.source);
		}
	}

	const previousOwnedFiles = new Map<string, OwnedFileSnapshot>();
	for (const owned of previousState?.ownedFiles ?? []) previousOwnedFiles.set(owned.target, owned);
	const nextOwnedFiles: OwnedFileSnapshot[] = [];
	const desiredFileTargets = new Set<string>();
	for (const file of options.manifest.files) {
		const expandedTarget = expandHome(file.target);
		desiredFileTargets.add(file.target);
		const desired = options.gistFiles.get(file.source);
		if (desired === undefined) throw new ApplyError(`Manifest references missing file: ${file.source}`);
		const snapshot = previousOwnedFiles.get(file.target) ?? (await snapshotFile(file.target, expandedTarget));
		await writeManagedFile(expandedTarget, desired, file.mode);
		logger(`wrote ${expandedTarget}`);
		nextOwnedFiles.push(snapshot);
	}
	for (const owned of previousOwnedFiles.values()) {
		if (desiredFileTargets.has(owned.target)) continue;
		await restoreFile(owned);
		logger(`restored ${expandHome(owned.target)}`);
	}

	const previousOwnedSettings = new Map<string, OwnedSettingSnapshot>();
	for (const owned of previousState?.ownedSettings ?? []) previousOwnedSettings.set(owned.key, owned);
	const nextOwnedSettings: OwnedSettingSnapshot[] = [];
	const nextSettingsValue = { ...currentSettings };
	const desiredSettingsKeys = new Set(Object.keys(options.manifest.settings));
	for (const [key, value] of Object.entries(options.manifest.settings)) {
		const snapshot = previousOwnedSettings.get(key) ?? {
			key,
			previousValue: currentSettings[key],
			previouslyPresent: key in currentSettings,
		};
		nextSettingsValue[key] = value;
		nextOwnedSettings.push(snapshot);
	}
	for (const owned of previousOwnedSettings.values()) {
		if (desiredSettingsKeys.has(owned.key)) continue;
		if (owned.previouslyPresent) nextSettingsValue[owned.key] = owned.previousValue;
		else delete nextSettingsValue[owned.key];
	}
	await writeSettings(settingsFile, nextSettingsValue);

	for (const command of options.manifest.postApply) {
		logger(`postApply: ${command}`);
		await runShellCommand(command, env);
	}

	const state: ProfileState = {
		apiVersion: "pi-profile-state/v1",
		sourceUrl: options.source.url,
		sourceKind: options.source.kind,
		gistId: options.source.gistId,
		pinnedVersion: options.source.version,
		lastSyncedAt: new Date().toISOString(),
		manifestSha256: hashManifest(options.manifestText),
		ownedPackages: [...nextOwnedPackages],
		ownedSettings: nextOwnedSettings,
		ownedFiles: nextOwnedFiles,
	};
	await writeState(state, { stateFile: options.stateFile });
	// previousOwnedPackages unused in state but inform logger of removals already done above
	void previousOwnedPackages;

	return { drift, state, dryRun: false };
}

export class ApplyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApplyError";
	}
}

async function readSettings(settingsFile: string): Promise<Record<string, unknown>> {
	try {
		const text = await readFile(settingsFile, "utf8");
		const parsed = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch (error) {
		if (isNotFound(error)) return {};
		throw error;
	}
}

async function writeSettings(settingsFile: string, value: Record<string, unknown>): Promise<void> {
	await mkdir(path.dirname(settingsFile), { recursive: true });
	await writeFile(settingsFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readFiles(targets: string[]): Promise<Record<string, string | undefined>> {
	const result: Record<string, string | undefined> = {};
	await Promise.all(
		targets.map(async (target) => {
			try {
				result[target] = await readFile(target, "utf8");
			} catch (error) {
				if (isNotFound(error)) result[target] = undefined;
				else throw error;
			}
		}),
	);
	return result;
}

async function writeManagedFile(target: string, content: string, mode?: number): Promise<void> {
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, content, "utf8");
	if (mode !== undefined) await chmod(target, mode);
}

async function snapshotFile(originalTarget: string, expandedTarget: string): Promise<OwnedFileSnapshot> {
	try {
		const previousContent = await readFile(expandedTarget, "utf8");
		return { target: originalTarget, previousContent, previousMode: null };
	} catch (error) {
		if (isNotFound(error)) return { target: originalTarget, previousContent: null, previousMode: null };
		throw error;
	}
}

async function restoreFile(snapshot: OwnedFileSnapshot): Promise<void> {
	const expanded = expandHome(snapshot.target);
	if (snapshot.previousContent === null) {
		await rm(expanded, { force: true });
		return;
	}
	await writeFile(expanded, snapshot.previousContent, "utf8");
	if (snapshot.previousMode !== null) await chmod(expanded, snapshot.previousMode);
}

function createSpawnInstaller(piBin: string, logger: (line: string) => void): PiInstaller {
	return async (action, source) => {
		const args = action === "install" ? ["install", source] : ["remove", source];
		await spawnAndWait(piBin, args, logger);
	};
}

function spawnAndWait(command: string, args: string[], logger: (line: string) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		const captureOutput = (stream: ChildProcess["stdout"]) => {
			if (!stream) return;
			let buffer = "";
			stream.on("data", (chunk: Buffer | string) => {
				buffer += typeof chunk === "string" ? chunk : chunk.toString();
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline);
					if (line.trim()) logger(line);
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
			});
			stream.on("end", () => {
				if (buffer.trim()) logger(buffer.trim());
			});
		};
		captureOutput(child.stdout);
		captureOutput(child.stderr);
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new ApplyError(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
		});
	});
}

function runShellCommand(command: string, env: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, { stdio: "inherit", shell: true, env });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new ApplyError(`postApply command exited with code ${code ?? "null"}: ${command}`));
		});
	});
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
