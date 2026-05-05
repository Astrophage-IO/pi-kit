#!/usr/bin/env bun
import { unlinkSync } from "node:fs";
import { PiBusServer, type PiBusServerOptions } from "../src/server.ts";
import { DEFAULT_HOST, DEFAULT_PORT } from "../src/protocol.ts";

interface ServerCliOptions extends PiBusServerOptions {
	host: string;
	port: number;
	historyLimit: number;
	verbose: boolean;
}

function usage(): void {
	console.log(`Usage: pi-bus-server [options]\n\nOptions:\n  --host <host>       Host to bind (default: ${DEFAULT_HOST})\n  --port <port>       TCP port to bind (default: ${DEFAULT_PORT}; 0 picks a free port)\n  --socket <path>     Bind a Unix domain socket instead of TCP\n  --token <token>     Require clients to send this shared token\n  --history <count>   Number of events to retain for history (default: 500)\n  --verbose           Log connections and publications to stdout\n  --version           Print version\n  -h, --help          Show help\n\nEnvironment:\n  PIBUS_HOST, PIBUS_PORT, PIBUS_SOCKET, PIBUS_TOKEN, PIBUS_HISTORY\n`);
}

async function version(): Promise<string> {
	const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version?: string };
	return pkg.version ?? "0.0.0";
}

function parseArgs(argv: string[]): ServerCliOptions {
	const options: ServerCliOptions = {
		host: process.env.PIBUS_HOST ?? DEFAULT_HOST,
		port: parsePort(process.env.PIBUS_PORT ?? String(DEFAULT_PORT), "PIBUS_PORT", true),
		socketPath: process.env.PIBUS_SOCKET || undefined,
		token: process.env.PIBUS_TOKEN || undefined,
		historyLimit: parsePositiveInteger(process.env.PIBUS_HISTORY ?? "500", "PIBUS_HISTORY"),
		verbose: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--host":
				options.host = readValue(argv, ++i, arg);
				break;
			case "--port":
				options.port = parsePort(readValue(argv, ++i, arg), arg, true);
				break;
			case "--socket":
				options.socketPath = readValue(argv, ++i, arg);
				break;
			case "--token":
				options.token = readValue(argv, ++i, arg);
				break;
			case "--history":
				options.historyLimit = parsePositiveInteger(readValue(argv, ++i, arg), arg);
				break;
			case "--verbose":
				options.verbose = true;
				break;
			case "--":
				if (i !== argv.length - 1) throw new Error(`Unexpected positional argument: ${argv[i + 1]}`);
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

async function main(argv: string[]): Promise<void> {
	if (argv.includes("-h") || argv.includes("--help")) {
		usage();
		return;
	}
	if (argv.includes("--version")) {
		console.log(await version());
		return;
	}

	const options = parseArgs(argv);
	if (options.socketPath) {
		try {
			unlinkSync(options.socketPath);
		} catch {
			// Ignore stale socket cleanup failures; listen() reports real bind errors.
		}
	}

	const server = new PiBusServer(options);
	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.error(`\n[pi-bus] received ${signal}; shutting down`);
		try {
			await server.close();
			process.exit(0);
		} catch (error) {
			process.stderr.write(`pi-bus-server: failed to shut down: ${errorMessage(error)}\n`);
			process.exit(1);
		}
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	await server.listen();
	const address = server.address();
	if (typeof address === "string") console.error(`[pi-bus] listening on ${address}`);
	else if (address) console.error(`[pi-bus] listening on ${address.address}:${address.port}`);
	else console.error("[pi-bus] listening");
}

function readValue(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function parsePositiveInteger(value: string, label: string): number {
	const numberValue = Number(value);
	if (!Number.isInteger(numberValue) || numberValue <= 0) throw new Error(`${label} must be a positive integer, got: ${value}`);
	return numberValue;
}

function parsePort(value: string, label: string, allowZero: boolean): number {
	const numberValue = Number(value);
	const min = allowZero ? 0 : 1;
	if (!Number.isInteger(numberValue) || numberValue < min || numberValue > 65_535) throw new Error(`${label} must be a TCP port between ${min} and 65535, got: ${value}`);
	return numberValue;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

main(process.argv.slice(2)).catch((error: unknown) => {
	process.stderr.write(`pi-bus-server: ${errorMessage(error)}\n`);
	process.stderr.write("Run `pi-bus-server --help` for usage.\n");
	process.exit(1);
});
