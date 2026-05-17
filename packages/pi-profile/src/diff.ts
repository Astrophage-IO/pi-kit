import { listFilesReferenced, packageSourceId, type Manifest } from "./manifest.ts";
import type { ProfileState } from "./state.ts";

export interface PackageChange {
	kind: "add" | "remove";
	source: string;
}

export interface SettingChange {
	kind: "set" | "unset" | "change";
	key: string;
	previous?: unknown;
	next?: unknown;
}

export interface FileChange {
	kind: "create" | "update" | "restore";
	target: string;
}

export interface EnvAdvisory {
	key: string;
	value: string;
}

export interface DriftReport {
	packages: PackageChange[];
	settings: SettingChange[];
	files: FileChange[];
	env: EnvAdvisory[];
	missingRequiredSecrets: string[];
	missingOptionalSecrets: string[];
	clean: boolean;
}

export interface ComputeDriftInputs {
	manifest: Manifest;
	currentSettings: Record<string, unknown>;
	currentFileContents: Record<string, string | undefined>;
	currentEnv: NodeJS.ProcessEnv;
	state?: ProfileState;
	gistFiles: Map<string, string>;
}

export function computeDrift(inputs: ComputeDriftInputs): DriftReport {
	const desiredPackages = new Set(inputs.manifest.packages.map(packageSourceId));
	const ownedPackages = new Set(inputs.state?.ownedPackages ?? []);
	const packages: PackageChange[] = [];
	for (const source of desiredPackages) {
		if (!ownedPackages.has(source)) packages.push({ kind: "add", source });
	}
	for (const source of ownedPackages) {
		if (!desiredPackages.has(source)) packages.push({ kind: "remove", source });
	}

	const settings: SettingChange[] = [];
	for (const [key, next] of Object.entries(inputs.manifest.settings)) {
		const current = inputs.currentSettings[key];
		if (current === undefined && next !== undefined) {
			settings.push({ kind: "set", key, next });
		} else if (!deepEqual(current, next)) {
			settings.push({ kind: "change", key, previous: current, next });
		}
	}
	const desiredKeys = new Set(Object.keys(inputs.manifest.settings));
	for (const owned of inputs.state?.ownedSettings ?? []) {
		if (!desiredKeys.has(owned.key)) {
			settings.push({ kind: "unset", key: owned.key, previous: inputs.currentSettings[owned.key] });
		}
	}

	const files: FileChange[] = [];
	for (const file of inputs.manifest.files) {
		const desired = inputs.gistFiles.get(file.source);
		if (desired === undefined) continue;
		const current = inputs.currentFileContents[file.target];
		if (current === undefined) files.push({ kind: "create", target: file.target });
		else if (current !== desired) files.push({ kind: "update", target: file.target });
	}
	const desiredFileTargets = new Set(inputs.manifest.files.map((file) => file.target));
	for (const owned of inputs.state?.ownedFiles ?? []) {
		if (!desiredFileTargets.has(owned.target)) files.push({ kind: "restore", target: owned.target });
	}

	const env: EnvAdvisory[] = [];
	for (const [key, value] of Object.entries(inputs.manifest.env)) {
		if (inputs.currentEnv[key] !== value) env.push({ key, value });
	}

	const missingRequiredSecrets = (inputs.manifest.secrets.required ?? []).filter((key) => !inputs.currentEnv[key]);
	const missingOptionalSecrets = (inputs.manifest.secrets.optional ?? []).filter((key) => !inputs.currentEnv[key]);

	const clean = packages.length === 0 && settings.length === 0 && files.length === 0;
	// referenced file presence is informational only; surface via clean=false if any are missing
	const missingReferences = listFilesReferenced(inputs.manifest).filter((name) => !inputs.gistFiles.has(name));
	return {
		packages,
		settings,
		files,
		env,
		missingRequiredSecrets,
		missingOptionalSecrets,
		clean: clean && missingReferences.length === 0,
	};
}

export function formatDrift(drift: DriftReport): string {
	if (drift.clean && drift.missingRequiredSecrets.length === 0 && drift.env.length === 0) {
		return "Profile is in sync.";
	}
	const lines: string[] = [];
	if (drift.packages.length > 0) {
		lines.push("Packages:");
		for (const change of drift.packages) lines.push(`  ${change.kind === "add" ? "+" : "-"} ${change.source}`);
	}
	if (drift.settings.length > 0) {
		lines.push("Settings:");
		for (const change of drift.settings) {
			if (change.kind === "set") lines.push(`  + ${change.key} = ${formatValue(change.next)}`);
			else if (change.kind === "unset") lines.push(`  - ${change.key} (restore: ${formatValue(change.previous)})`);
			else lines.push(`  ~ ${change.key}: ${formatValue(change.previous)} -> ${formatValue(change.next)}`);
		}
	}
	if (drift.files.length > 0) {
		lines.push("Files:");
		for (const change of drift.files) {
			const prefix = change.kind === "create" ? "+" : change.kind === "update" ? "~" : "-";
			lines.push(`  ${prefix} ${change.target}${change.kind === "restore" ? " (restore previous)" : ""}`);
		}
	}
	if (drift.env.length > 0) {
		lines.push("Env (export these before pi runs):");
		for (const advisory of drift.env) lines.push(`  export ${advisory.key}=${shellEscape(advisory.value)}`);
	}
	if (drift.missingRequiredSecrets.length > 0) {
		lines.push("Missing required secrets:");
		for (const key of drift.missingRequiredSecrets) lines.push(`  ! ${key}`);
	}
	if (drift.missingOptionalSecrets.length > 0) {
		lines.push("Missing optional secrets:");
		for (const key of drift.missingOptionalSecrets) lines.push(`  ? ${key}`);
	}
	return lines.join("\n");
}

function formatValue(value: unknown): string {
	if (value === undefined) return "(unset)";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function shellEscape(value: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const aa = a;
		const bb = b as unknown[];
		if (aa.length !== bb.length) return false;
		for (let i = 0; i < aa.length; i++) if (!deepEqual(aa[i], bb[i])) return false;
		return true;
	}
	const aRecord = a as Record<string, unknown>;
	const bRecord = b as Record<string, unknown>;
	const keys = new Set([...Object.keys(aRecord), ...Object.keys(bRecord)]);
	for (const key of keys) if (!deepEqual(aRecord[key], bRecord[key])) return false;
	return true;
}
