#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	marathonPaths,
	readState,
	writeState,
	writeSummary,
	type MarathonPaths,
	type MissionState,
} from "../src/mission.ts";
import { readResults } from "../src/results.ts";
import { renderStatus } from "../src/status.ts";

interface ParsedArgs {
	command: string;
	positional: string[];
	flags: Record<string, string | boolean>;
}

function usage(): void {
	const lines = [
		"Usage: pi-marathon <command> [options]",
		"",
		"Commands:",
		"  status                Show mission progress (reads .marathon/, no pi boot).",
		"  pause                 Pause the auto-loop without ending the mission.",
		"  resume                Resume the auto-loop.",
		"  stop [reason]         End the mission and write summary.md.",
		"  start                 Print the recommended `pi` command to launch the session.",
		"",
		"Options:",
		"  --dir <path>          Mission directory (default: <cwd>/.marathon or $PI_MARATHON_DIR).",
		"  -h, --help            Show this help.",
		"  --version             Print version.",
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
			} else if (key === "help") {
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

function readDirFlag(flags: ParsedArgs["flags"]): string | undefined {
	const value = flags.dir;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolvePaths(flags: ParsedArgs["flags"]): MarathonPaths {
	return marathonPaths(process.cwd(), readDirFlag(flags));
}

async function commandStatus(args: ParsedArgs): Promise<void> {
	const paths = resolvePaths(args.flags);
	const state = await readState(paths);
	if (!state) {
		console.log(`No marathon mission at ${paths.dir}. Start one inside pi with marathon_configure.`);
		process.exitCode = 1;
		return;
	}
	const rows = await readResults(paths.results);
	console.log(renderStatus(state, rows));
}

async function commandPause(args: ParsedArgs): Promise<void> {
	const paths = resolvePaths(args.flags);
	await mkdir(paths.dir, { recursive: true });
	await writeFile(paths.pause, `${new Date().toISOString()}\n`, "utf8");
	console.log(`Paused. Marathon ticks will skip until you run \`pi-marathon resume\`.`);
}

async function commandResume(args: ParsedArgs): Promise<void> {
	const paths = resolvePaths(args.flags);
	await rm(paths.pause, { force: true });
	console.log("Resumed. The next turn in the live session will continue the loop.");
}

async function commandStop(args: ParsedArgs): Promise<void> {
	const paths = resolvePaths(args.flags);
	const state = await readState(paths);
	if (!state) {
		console.log(`No marathon mission at ${paths.dir}.`);
		process.exitCode = 1;
		return;
	}
	const reason = args.positional.join(" ").trim() || "stopped via CLI";
	const next: MissionState = { ...state, status: state.status === "done" ? "done" : "stopped", terminationReason: reason };
	await writeState(paths, next);
	await writeSummary(paths, next, await readResults(paths.results));
	await writeFile(paths.stop, `${new Date().toISOString()} ${reason}\n`, "utf8");
	console.log(`Stopped: ${reason}. Summary written to ${paths.summary}.`);
}

function commandStart(args: ParsedArgs): void {
	// Prefer the self-contained bundle (always shipped in installed packages);
	// fall back to source in a pre-build dev checkout.
	const bundlePath = path.resolve(fileURLToPath(new URL("../dist/pi-marathon.js", import.meta.url)));
	const sourcePath = path.resolve(fileURLToPath(new URL("../extensions/pi-marathon.ts", import.meta.url)));
	const extensionPath = existsSync(bundlePath) ? bundlePath : sourcePath;
	const skillPath = path.resolve(fileURLToPath(new URL("../skills/marathon", import.meta.url)));
	const dir = readDirFlag(args.flags);
	const dirFlag = dir ? ` --marathon-dir ${dir}` : "";
	console.log(
		[
			"Launch a long-running marathon session with:",
			"",
			`  pi --skill ${skillPath} \\`,
			`     -e ${extensionPath}${dirFlag} \\`,
			`     "Read the marathon skill and set up a new mission, then loop."`,
			"",
			"After install you can use the shorter form:",
			"",
			`  pi --skill marathon "set up a marathon mission and loop"`,
			"",
			"Run it inside tmux so the session survives terminal disconnects.",
		].join("\n"),
	);
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
		case "status":
			return commandStatus(parsed);
		case "pause":
			return commandPause(parsed);
		case "resume":
			return commandResume(parsed);
		case "stop":
			return commandStop(parsed);
		case "start":
			return commandStart(parsed);
		default:
			throw new Error(`Unknown command: ${parsed.command || "(missing)"}`);
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`pi-marathon: ${message}\n`);
	process.stderr.write("Run `pi-marathon --help` for usage.\n");
	process.exit(1);
});
