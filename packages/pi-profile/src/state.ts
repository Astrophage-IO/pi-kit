import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_STATE_DIR = path.join(os.homedir(), ".pi", "profile");
export const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, "state.json");
export const DEFAULT_SECRETS_FILE = path.join(DEFAULT_STATE_DIR, "secrets.env");

export interface OwnedFileSnapshot {
	target: string;
	previousContent: string | null;
	previousMode: number | null;
}

export interface OwnedSettingSnapshot {
	key: string;
	previousValue: unknown;
	previouslyPresent: boolean;
}

export interface ProfileState {
	apiVersion: "pi-profile-state/v1";
	sourceUrl: string;
	sourceKind: "gist" | "local";
	gistId?: string;
	pinnedVersion?: string;
	lastSyncedAt: string;
	manifestSha256: string;
	ownedPackages: string[];
	ownedSettings: OwnedSettingSnapshot[];
	ownedFiles: OwnedFileSnapshot[];
}

export interface ResolveStatePathOptions {
	stateFile?: string;
}

export function resolveStateFile(options: ResolveStatePathOptions = {}): string {
	return options.stateFile ?? process.env.PI_PROFILE_STATE_FILE ?? DEFAULT_STATE_FILE;
}

export async function readState(options: ResolveStatePathOptions = {}): Promise<ProfileState | undefined> {
	const target = resolveStateFile(options);
	let text: string;
	try {
		text = await readFile(target, "utf8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
	const parsed = JSON.parse(text) as ProfileState;
	if (parsed.apiVersion !== "pi-profile-state/v1") {
		throw new Error(`Unsupported pi-profile state apiVersion: ${parsed.apiVersion}`);
	}
	return parsed;
}

export async function writeState(state: ProfileState, options: ResolveStatePathOptions = {}): Promise<void> {
	const target = resolveStateFile(options);
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function hashManifest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function emptyState(sourceUrl: string, sourceKind: ProfileState["sourceKind"]): ProfileState {
	return {
		apiVersion: "pi-profile-state/v1",
		sourceUrl,
		sourceKind,
		lastSyncedAt: new Date(0).toISOString(),
		manifestSha256: "",
		ownedPackages: [],
		ownedSettings: [],
		ownedFiles: [],
	};
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
