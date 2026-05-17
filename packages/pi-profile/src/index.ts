export {
	MANIFEST_API_VERSION,
	MANIFEST_FILE_NAME,
	ManifestError,
	listFilesReferenced,
	packageSourceId,
	parseManifest,
	resolveManifest,
} from "./manifest.ts";
export type {
	Manifest,
	ManifestApiVersion,
	ManifestFile,
	ManifestHostOverlay,
	ManifestSecrets,
	PackageSpec,
	ResolveManifestOptions,
} from "./manifest.ts";

export {
	SourceError,
	fetchProfileSource,
	loadLocalManifest,
	loadLocalManifestDirectory,
	materializePendingFiles,
	parseGistReference,
} from "./source.ts";
export type { FetchedManifest, ParsedGistUrl, ProfileSource } from "./source.ts";

export {
	DEFAULT_SECRETS_FILE,
	DEFAULT_STATE_DIR,
	DEFAULT_STATE_FILE,
	emptyState,
	hashManifest,
	readState,
	resolveStateFile,
	writeState,
} from "./state.ts";
export type { OwnedFileSnapshot, OwnedSettingSnapshot, ProfileState, ResolveStatePathOptions } from "./state.ts";

export { computeDrift, formatDrift } from "./diff.ts";
export type { ComputeDriftInputs, DriftReport, EnvAdvisory, FileChange, PackageChange, SettingChange } from "./diff.ts";

export { ApplyError, applyManifest } from "./apply.ts";
export type { ApplyOptions, ApplyResult, PiInstaller } from "./apply.ts";
