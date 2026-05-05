#!/usr/bin/env bun
import { unlinkSync } from "node:fs";
import { PiBusServer } from "../src/server.ts";
import { DEFAULT_HOST, DEFAULT_PORT } from "../src/protocol.ts";

function usage() {
	console.log(`Usage: pi-bus-server [options]\n\nOptions:\n  --host <host>       Host to bind (default: ${DEFAULT_HOST})\n  --port <port>       TCP port to bind (default: ${DEFAULT_PORT})\n  --socket <path>     Bind a Unix domain socket instead of TCP\n  --token <token>     Require clients to send this shared token\n  --history <count>   Number of events to retain for history (default: 500)\n  --verbose           Log connections and publications to stderr\n  -h, --help          Show help\n\nEnvironment:\n  PIBUS_HOST, PIBUS_PORT, PIBUS_SOCKET, PIBUS_TOKEN, PIBUS_HISTORY\n`);
}

function parseArgs(argv) {
	const options = {
		host: process.env.PIBUS_HOST ?? DEFAULT_HOST,
		port: Number(process.env.PIBUS_PORT ?? DEFAULT_PORT),
		socketPath: process.env.PIBUS_SOCKET || undefined,
		token: process.env.PIBUS_TOKEN || undefined,
		historyLimit: Number(process.env.PIBUS_HISTORY ?? 500),
		verbose: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--host":
				options.host = argv[++i];
				break;
			case "--port":
				options.port = Number(argv[++i]);
				break;
			case "--socket":
				options.socketPath = argv[++i];
				break;
			case "--token":
				options.token = argv[++i];
				break;
			case "--history":
				options.historyLimit = Number(argv[++i]);
				break;
			case "--verbose":
				options.verbose = true;
				break;
			case "-h":
			case "--help":
				usage();
				process.exit(0);
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.socketPath) {
	try {
		unlinkSync(options.socketPath);
	} catch {
		// ignore stale socket cleanup failures; listen() will report real bind errors
	}
}

const server = new PiBusServer(options);
await server.listen();
const address = server.address();
if (typeof address === "string") console.error(`[pi-bus] listening on ${address}`);
else console.error(`[pi-bus] listening on ${address.address}:${address.port}`);

const shutdown = async () => {
	console.error("\n[pi-bus] shutting down");
	await server.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
