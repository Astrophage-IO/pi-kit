import os from "node:os";

export const MANIFEST_API_VERSION = "pi-profile/v1" as const;
export const MANIFEST_FILE_NAME = "pi-profile.json" as const;

export type ManifestApiVersion = typeof MANIFEST_API_VERSION;

export type PackageSpec =
	| string
	| {
		source: string;
		extensions?: string[];
		skills?: string[];
		prompts?: string[];
		themes?: string[];
	};

export interface ManifestFile {
	target: string;
	source: string;
	mode?: number;
}

export interface ManifestSecrets {
	required?: string[];
	optional?: string[];
}

export interface ManifestHostOverlay {
	packages?: PackageSpec[];
	settings?: Record<string, unknown>;
	env?: Record<string, string>;
	files?: ManifestFile[];
	postApply?: string[];
}

export interface Manifest {
	apiVersion: ManifestApiVersion;
	name?: string;
	description?: string;
	packages: PackageSpec[];
	settings: Record<string, unknown>;
	env: Record<string, string>;
	files: ManifestFile[];
	secrets: ManifestSecrets;
	hosts: Record<string, ManifestHostOverlay>;
	postApply: string[];
}

export interface ResolveManifestOptions {
	hostname?: string;
}

export class ManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManifestError";
	}
}

export function parseManifest(input: unknown): Manifest {
	if (!isRecord(input)) throw new ManifestError("Manifest must be a JSON object");
	const apiVersion = input.apiVersion;
	if (apiVersion !== MANIFEST_API_VERSION) {
		throw new ManifestError(`Unsupported apiVersion: ${stringifyForError(apiVersion)}. Expected ${MANIFEST_API_VERSION}.`);
	}
	const packages = parsePackages(input.packages, "packages");
	const settings = parseRecord(input.settings, "settings");
	const env = parseEnv(input.env, "env");
	const files = parseFiles(input.files, "files");
	const secrets = parseSecrets(input.secrets);
	const hosts = parseHosts(input.hosts);
	const postApply = parseStringArray(input.postApply, "postApply");
	return {
		apiVersion: MANIFEST_API_VERSION,
		name: optionalString(input.name, "name"),
		description: optionalString(input.description, "description"),
		packages,
		settings,
		env,
		files,
		secrets,
		hosts,
		postApply,
	};
}

export function resolveManifest(manifest: Manifest, options: ResolveManifestOptions = {}): Manifest {
	const hostname = options.hostname ?? process.env.PI_PROFILE_HOST ?? os.hostname();
	const overlay = manifest.hosts[hostname];
	if (!overlay) return manifest;
	return {
		...manifest,
		packages: [...manifest.packages, ...(overlay.packages ?? [])],
		settings: { ...manifest.settings, ...(overlay.settings ?? {}) },
		env: { ...manifest.env, ...(overlay.env ?? {}) },
		files: mergeFiles(manifest.files, overlay.files ?? []),
		postApply: [...manifest.postApply, ...(overlay.postApply ?? [])],
	};
}

export function packageSourceId(spec: PackageSpec): string {
	return typeof spec === "string" ? spec : spec.source;
}

export function listFilesReferenced(manifest: Manifest): string[] {
	const sources = new Set<string>();
	for (const file of manifest.files) sources.add(file.source);
	for (const overlay of Object.values(manifest.hosts)) {
		for (const file of overlay.files ?? []) sources.add(file.source);
	}
	return [...sources];
}

function mergeFiles(base: ManifestFile[], overlay: ManifestFile[]): ManifestFile[] {
	const byTarget = new Map<string, ManifestFile>();
	for (const file of base) byTarget.set(file.target, file);
	for (const file of overlay) byTarget.set(file.target, file);
	return [...byTarget.values()];
}

function parsePackages(value: unknown, label: string): PackageSpec[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new ManifestError(`${label} must be an array`);
	return value.map((item, index) => parsePackageSpec(item, `${label}[${index}]`));
}

function parsePackageSpec(value: unknown, label: string): PackageSpec {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) throw new ManifestError(`${label} must be a non-empty string`);
		return trimmed;
	}
	if (!isRecord(value)) throw new ManifestError(`${label} must be a string or object`);
	const source = value.source;
	if (typeof source !== "string" || !source.trim()) {
		throw new ManifestError(`${label}.source is required and must be a non-empty string`);
	}
	const spec: PackageSpec = { source: source.trim() };
	if (value.extensions !== undefined) spec.extensions = parseStringArray(value.extensions, `${label}.extensions`);
	if (value.skills !== undefined) spec.skills = parseStringArray(value.skills, `${label}.skills`);
	if (value.prompts !== undefined) spec.prompts = parseStringArray(value.prompts, `${label}.prompts`);
	if (value.themes !== undefined) spec.themes = parseStringArray(value.themes, `${label}.themes`);
	return spec;
}

function parseFiles(value: unknown, label: string): ManifestFile[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new ManifestError(`${label} must be an array`);
	return value.map((item, index) => parseFile(item, `${label}[${index}]`));
}

function parseFile(value: unknown, label: string): ManifestFile {
	if (!isRecord(value)) throw new ManifestError(`${label} must be an object`);
	const target = value.target;
	const source = value.source;
	if (typeof target !== "string" || !target.trim()) throw new ManifestError(`${label}.target is required and must be a non-empty string`);
	if (typeof source !== "string" || !source.trim()) throw new ManifestError(`${label}.source is required and must be a non-empty string`);
	const file: ManifestFile = { target: target.trim(), source: source.trim() };
	if (value.mode !== undefined) {
		const mode = Number(value.mode);
		if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
			throw new ManifestError(`${label}.mode must be an octal integer between 0 and 0o777`);
		}
		file.mode = mode;
	}
	return file;
}

function parseSecrets(value: unknown): ManifestSecrets {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) throw new ManifestError("secrets must be an object");
	const result: ManifestSecrets = {};
	if (value.required !== undefined) result.required = parseStringArray(value.required, "secrets.required");
	if (value.optional !== undefined) result.optional = parseStringArray(value.optional, "secrets.optional");
	return result;
}

function parseHosts(value: unknown): Record<string, ManifestHostOverlay> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) throw new ManifestError("hosts must be an object");
	const hosts: Record<string, ManifestHostOverlay> = {};
	for (const [name, overlay] of Object.entries(value)) {
		if (!isRecord(overlay)) throw new ManifestError(`hosts.${name} must be an object`);
		const parsed: ManifestHostOverlay = {};
		if (overlay.packages !== undefined) parsed.packages = parsePackages(overlay.packages, `hosts.${name}.packages`);
		if (overlay.settings !== undefined) parsed.settings = parseRecord(overlay.settings, `hosts.${name}.settings`);
		if (overlay.env !== undefined) parsed.env = parseEnv(overlay.env, `hosts.${name}.env`);
		if (overlay.files !== undefined) parsed.files = parseFiles(overlay.files, `hosts.${name}.files`);
		if (overlay.postApply !== undefined) parsed.postApply = parseStringArray(overlay.postApply, `hosts.${name}.postApply`);
		hosts[name] = parsed;
	}
	return hosts;
}

function parseEnv(value: unknown, label: string): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) throw new ManifestError(`${label} must be an object`);
	const env: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new ManifestError(`${label} key ${key} must match [A-Z_][A-Z0-9_]*`);
		if (typeof raw !== "string") throw new ManifestError(`${label}.${key} must be a string`);
		env[key] = raw;
	}
	return env;
}

function parseRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) throw new ManifestError(`${label} must be an object`);
	return { ...value };
}

function parseStringArray(value: unknown, label: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new ManifestError(`${label} must be an array of strings`);
	return value.map((item, index) => {
		if (typeof item !== "string") throw new ManifestError(`${label}[${index}] must be a string`);
		return item;
	});
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new ManifestError(`${label} must be a string when provided`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyForError(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === undefined) return "(missing)";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
