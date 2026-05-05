#!/usr/bin/env bun
import { PiBusClient } from "../src/client.ts";
import { DEFAULT_HOST, DEFAULT_PORT } from "../src/protocol.ts";

function usage() {
	console.log(`Usage: pi-bus <command> [options]\n\nCommands:\n  server              Start a broker (same as pi-bus-server)\n  publish <text>      Publish a message from the CLI\n  peers               List connected peers\n  history             Print recent events\n\nCommon options:\n  --host <host>       Broker host (default: ${DEFAULT_HOST})\n  --port <port>       Broker port (default: ${DEFAULT_PORT})\n  --socket <path>     Broker Unix socket path\n  --token <token>     Shared token\n  --room <room>       Room (default: default)\n  --topic <topic>     Topic (default: agent.message)\n  --agent <id>        Agent/client id for this CLI process\n  -h, --help          Show help\n`);
}

function parseCommon(argv) {
	const options = {
		host: process.env.PIBUS_HOST ?? DEFAULT_HOST,
		port: Number(process.env.PIBUS_PORT ?? DEFAULT_PORT),
		socketPath: process.env.PIBUS_SOCKET || undefined,
		token: process.env.PIBUS_TOKEN || undefined,
		room: process.env.PIBUS_ROOM ?? "default",
		topic: process.env.PIBUS_TOPIC ?? "agent.message",
		agent: process.env.PIBUS_AGENT ?? `cli-${process.pid}`,
	};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--host": options.host = argv[++i]; break;
			case "--port": options.port = Number(argv[++i]); break;
			case "--socket": options.socketPath = argv[++i]; break;
			case "--token": options.token = argv[++i]; break;
			case "--room": options.room = argv[++i]; break;
			case "--topic": options.topic = argv[++i]; break;
			case "--agent": options.agent = argv[++i]; break;
			case "-h":
			case "--help": usage(); process.exit(0);
			default: rest.push(arg);
		}
	}
	return { options, rest };
}

const [command, ...argv] = process.argv.slice(2);
if (!command || command === "-h" || command === "--help") {
	usage();
	process.exit(0);
}

if (command === "server") {
	const { spawn } = await import("node:child_process");
	const { fileURLToPath } = await import("node:url");
	const serverBin = fileURLToPath(new URL("./pi-bus-server.ts", import.meta.url));
	const child = spawn(process.execPath, [serverBin, ...argv], { stdio: "inherit" });
	const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
	process.exit(code ?? 0);
}

const { options, rest } = parseCommon(argv);
const client = new PiBusClient({
	host: options.host,
	port: options.port,
	socketPath: options.socketPath,
	token: options.token,
	agent: { id: options.agent, name: options.agent },
	rooms: [options.room],
	topics: ["*"],
	reconnect: false,
});
await client.connect();
try {
	if (command === "publish") {
		const text = rest.join(" ").trim();
		if (!text) throw new Error("publish requires message text");
		const ack = await client.publish({ room: options.room, topic: options.topic, text });
		console.log(JSON.stringify(ack, null, 2));
	} else if (command === "peers") {
		const response = await client.requestPeers();
		console.log(JSON.stringify(response.peers, null, 2));
	} else if (command === "history") {
		const response = await client.requestHistory({ room: options.room, topic: options.topic, limit: 50 });
		console.log(JSON.stringify(response.events, null, 2));
	} else {
		throw new Error(`Unknown command: ${command}`);
	}
} finally {
	client.close();
}
