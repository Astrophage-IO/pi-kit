#!/usr/bin/env bun
/**
 * Bundle each pi extension entry into a single self-contained ESM file under
 * `dist/extensions/`, inlining real npm dependencies (e.g. @bufbuild/protobuf,
 * @modelcontextprotocol/sdk) so the published/installed extension never depends
 * on a co-located node_modules being present.
 *
 * Modules that the pi host injects at load time (pi-coding-agent, pi-tui, pi-ai,
 * pi-agent-core, typebox) are kept EXTERNAL — jiti resolves them via pi's
 * built-in aliases/virtualModules. Bundling them would shadow the host copies.
 *
 * Usage:
 *   bun run scripts/build-extensions.ts <packageDir>   # one package (defaults to cwd)
 *   bun run scripts/build-extensions.ts --all          # every workspace package
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Host-provided modules: keep external. Both the current (@earendil-works) and
// legacy (@mariozechner) scopes are aliased by the pi loader at runtime.
const EXTERNAL = [
	"@earendil-works/*",
	"@mariozechner/*",
	"typebox",
	"typebox/*",
	"@sinclair/typebox",
	"@sinclair/typebox/*",
];

function findSourceExtensions(pkgDir: string): string[] {
	const extDir = join(pkgDir, "extensions");
	if (!existsSync(extDir)) return [];
	return readdirSync(extDir)
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
		.map((name) => join(extDir, name))
		.sort();
}

function assertExportsFactory(outFile: string, srcFile: string): void {
	const code = readFileSync(outFile, "utf-8");
	// pi requires the extension's default export to be a factory function.
	if (!/export\s*{[^}]*\bas default\b/.test(code) && !/export default/.test(code)) {
		throw new Error(
			`Bundle for ${basename(srcFile)} has no default export — pi will reject it (${outFile})`,
		);
	}
}

async function buildPackage(pkgDirArg: string): Promise<number> {
	const pkgDir = isAbsolute(pkgDirArg) ? pkgDirArg : resolve(process.cwd(), pkgDirArg);
	const pkgJsonPath = join(pkgDir, "package.json");
	if (!existsSync(pkgJsonPath)) {
		throw new Error(`No package.json at ${pkgDir}`);
	}
	const pkgName = JSON.parse(readFileSync(pkgJsonPath, "utf-8")).name ?? basename(pkgDir);
	const sources = findSourceExtensions(pkgDir);
	if (sources.length === 0) {
		console.log(`  ${pkgName}: no extensions/ sources, skipping`);
		return 0;
	}

	// Output flat into dist/ (one level under the package root) so that an
	// extension computing `dirname(dirname(import.meta.url))` still resolves to
	// the package root — same depth as the source extensions/ dir. Bundling into
	// dist/extensions/ would shift that base and break co-located asset lookups
	// (agents/, config/, skills/).
	const outDir = join(pkgDir, "dist");
	rmSync(outDir, { recursive: true, force: true });

	for (const src of sources) {
		// Build each entry independently so every output is a single, fully
		// self-contained file (no shared chunks to resolve at load time).
		const result = await Bun.build({
			entrypoints: [src],
			outdir: outDir,
			target: "node",
			format: "esm",
			external: EXTERNAL,
			sourcemap: "linked",
			naming: "[name].js",
		});
		if (!result.success) {
			for (const log of result.logs) console.error(log);
			throw new Error(`Failed to bundle ${src}`);
		}
		const outFile = join(outDir, `${basename(src, ".ts")}.js`);
		assertExportsFactory(outFile, src);
		console.log(`  ${pkgName}: ${basename(src)} -> dist/${basename(src, ".ts")}.js`);
	}
	return sources.length;
}

function workspacePackageDirs(): string[] {
	// scripts/ lives at the repo root; packages live under packages/*.
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const packagesDir = join(repoRoot, "packages");
	if (!existsSync(packagesDir)) return [];
	return readdirSync(packagesDir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => join(packagesDir, e.name))
		.filter((dir) => existsSync(join(dir, "package.json")))
		.sort();
}

const arg = process.argv[2];
if (arg === "--all") {
	let total = 0;
	for (const dir of workspacePackageDirs()) total += await buildPackage(dir);
	console.log(`Built ${total} extension bundle(s).`);
} else {
	await buildPackage(arg ?? process.cwd());
}
