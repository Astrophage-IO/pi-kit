#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PiBusClient } from "../src/client.ts";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_ROOM, DEFAULT_TOPIC } from "../src/protocol.ts";

interface CommonOptions {
	host: string;
	port: number;
	socketPath?: string;
	token?: string;
	room: string;
	topic: string;
	agent: string;
	timeoutMs: number;
}

function usage(): void {
	console.log(`Usage: pi-bus <command> [options]\n\nCommands:\n  server              Start a broker (same as pi-bus-server)\n  publish <text>      Publish a message from the CLI\n  peers               List connected peers\n  history             Print recent events\n\nCommon options:\n  --host <host>       Broker host (default: ${DEFAULT_HOST})\n  --port <port>       Broker port (default: ${DEFAULT_PORT})\n  --socket <path>     Broker Unix socket path\n  --token <token>     Shared token\n  --room <room>       Room (default: ${DEFAULT_ROOM})\n  --topic <topic>     Topic (default: ${DEFAULT_TOPIC})\n  --agent <id>        Agent/client id for this CLI process\n  --timeout <ms>      Command timeout in milliseconds (default: 15000)\n  --version           Print version\n  -h, --help          Show help\n\nUse -- before publish text that starts with a dash.\n`);
}

async function version(): Promise<string> {
	const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version?: string };
	return pkg.version ?? "0.0.0";
}

function parseCommon(argv: string[]): { options: CommonOptions; rest: string[] } {
	const options: CommonOptions = {
		host: process.env.PIBUS_HOST ?? DEFAULT_HOST,
		port: parsePort(process.env.PIBUS_PORT ?? String(DEFAULT_PORT), "PIBUS_PORT"),
		socketPath: process.env.PIBUS_SOCKET || undefined,
		token: process.env.PIBUS_TOKEN || undefined,
		room: process.env.PIBUS_ROOM ?? DEFAULT_ROOM,
		topic: process.env.PIBUS_TOPIC ?? DEFAULT_TOPIC,
		agent: process.env.PIBUS_AGENT ?? `cli-${process.pid}`,
		timeoutMs: parsePositiveInteger(process.env.PIBUS_TIMEOUT ?? "15000", "PIBUS_TIMEOUT"),
	};
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) break;
		switch (arg) {
			case "--host":
				options.host = readValue(argv, ++i, arg);
				break;
			case "--port":
				options.port = parsePort(readValue(argv, ++i, arg), arg);
				break;
			case "--socket":
				options.socketPath = readValue(argv, ++i, arg);
				break;
			case "--token":
				options.token = readValue(argv, ++i, arg);
				break;
			case "--room":
				options.room = readValue(argv, ++i, arg);
				break;
			case "--topic":
				options.topic = readValue(argv, ++i, arg);
				break;
			case "--agent":
				options.agent = readValue(argv, ++i, arg);
				break;
			case "--timeout":
				options.timeoutMs = parsePositiveInteger(readValue(argv, ++i, arg), arg);
				break;
			case "--":
				rest.push(...argv.slice(i + 1));
				i = argv.length;
				break;
			case "-h":
			case "--help":
				usage();
				process.exit(0);
			default:
				if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
				rest.push(arg);
		}
	}
	return { options, rest };
}

async function runServerSubcommand(argv: string[]): Promise<never> {
	const serverBin = fileURLToPath(new URL("./pi-bus-server.ts", import.meta.url));
	const child = spawn(process.execPath, [serverBin, ...argv], { stdio: "inherit" });
	const forwardSigint = () => child.kill("SIGINT");
	const forwardSigterm = () => child.kill("SIGTERM");
	process.once("SIGINT", forwardSigint);
	process.once("SIGTERM", forwardSigterm);
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on("close", (code, signal) => resolve({ code, signal }));
	});
	process.off("SIGINT", forwardSigint);
	process.off("SIGTERM", forwardSigterm);
	if (result.signal) process.exit(128 + signalNumber(result.signal));
	process.exit(result.code ?? 1);
}

async function main(argv: string[]): Promise<void> {
	const [command, ...commandArgv] = argv;
	if (!command || command === "-h" || command === "--help") {
		usage();
		return;
	}
	if (command === "--version") {
		console.log(await version());
		return;
	}
	if (command === "server") await runServerSubcommand(commandArgv);

	const { options, rest } = parseCommon(commandArgv);
	const abortController = new AbortController();
	let client: PiBusClient | undefined;
	const stop = (signal: NodeJS.Signals) => {
		abortController.abort(new Error(`Interrupted by ${signal}`));
		client?.close();
		process.exit(128 + signalNumber(signal));
	};
	const stopSigint = () => stop("SIGINT");
	const stopSigterm = () => stop("SIGTERM");
	process.once("SIGINT", stopSigint);
	process.once("SIGTERM", stopSigterm);

	try {
		client = new PiBusClient({
			host: options.host,
			port: options.port,
			socketPath: options.socketPath,
			token: options.token,
			agent: { id: options.agent, name: options.agent },
			rooms: [options.room],
			topics: ["*"],
			reconnect: false,
			commandTimeoutMs: options.timeoutMs,
		});
		await client.connect({ signal: abortController.signal });
		if (command === "publish") {
			const text = rest.join(" ").trim();
			if (!text) throw new Error("publish requires message text");
			const ack = await client.publish({ room: options.room, topic: options.topic, text, hints: { push: true } }, { signal: abortController.signal });
			console.log(JSON.stringify(ack, null, 2));
		} else if (command === "peers") {
			const response = await client.requestPeers({ signal: abortController.signal });
			console.log(JSON.stringify(response.peers, null, 2));
		} else if (command === "history") {
			const response = await client.requestHistory({ room: options.room, topic: options.topic, limit: 50, signal: abortController.signal });
			console.log(JSON.stringify(response.events, null, 2));
		} else {
			throw new Error(`Unknown command: ${command}`);
		}
	} finally {
		process.off("SIGINT", stopSigint);
		process.off("SIGTERM", stopSigterm);
		client?.close();
	}
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

function parsePort(value: string, label: string): number {
	const numberValue = Number(value);
	if (!Number.isInteger(numberValue) || numberValue < 1 || numberValue > 65_535) throw new Error(`${label} must be a TCP port between 1 and 65535, got: ${value}`);
	return numberValue;
}

function signalNumber(signal: NodeJS.Signals): number {
	switch (signal) {
		case "SIGINT":
			return 2;
		case "SIGTERM":
			return 15;
		default:
			return 1;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

main(process.argv.slice(2)).catch((error: unknown) => {
	process.stderr.write(`pi-bus: ${errorMessage(error)}\n`);
	process.stderr.write("Run `pi-bus --help` for usage.\n");
	process.exit(1);
});
