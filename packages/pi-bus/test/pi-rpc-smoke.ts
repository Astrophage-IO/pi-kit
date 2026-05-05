#!/usr/bin/env node
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { PiBusServer } from "../src/server.ts";

const cwd = new URL("..", import.meta.url).pathname;

type RpcResponse = { success?: boolean; error?: string; data?: any; [key: string]: any };

function attachJsonlReader(stream: any, onLine: (line: string) => void) {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	stream.on("data", (chunk) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			let line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.trim()) onLine(line);
		}
	});
}

class PiRpcAgent {
	[key: string]: any;

	constructor({ id, name, port }: { id: string; name: string; port: number }) {
		this.id = id;
		this.name = name;
		this.events = [];
		this.pending = new Map();
		this.stderr = "";
		this.proc = spawn(
			"pi",
			["--mode", "rpc", "--no-session", "--no-builtin-tools", "-e", "./extensions/pi-bus.ts"],
			{
				cwd,
				env: {
					...process.env,
					PIBUS_HOST: "127.0.0.1",
					PIBUS_PORT: String(port),
					PIBUS_AGENT: id,
					PIBUS_NAME: name,
					PIBUS_TOPICS: "*",
					PIBUS_AUTOSTART: "1",
					PI_SKIP_VERSION_CHECK: "1",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.proc.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
		attachJsonlReader(this.proc.stdout, (line) => {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			this.events.push(message);
			if (message.type === "response" && message.id && this.pending.has(message.id)) {
				const pending = this.pending.get(message.id);
				this.pending.delete(message.id);
				clearTimeout(pending.timeout);
				pending.resolve(message);
			}
		});
	}

	send(command: Record<string, any>, timeoutMs = 15_000): Promise<RpcResponse> {
		const id = command.id ?? `${this.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${this.id} RPC timeout for ${command.type}\n${this.stderr}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			this.proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	async getMessages() {
		const response = await this.send({ type: "get_messages" });
		if (!response.success) throw new Error(`${this.id} get_messages failed: ${response.error}`);
		return response.data.messages;
	}

	async hasMessageText(text: string) {
		const messages = await this.getMessages();
		return messages.some((message: any) => JSON.stringify(message).includes(text));
	}

	async waitForMessageText(text: string, timeoutMs = 5_000) {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const messages = await this.getMessages();
			const found = messages.find((message: any) => JSON.stringify(message).includes(text));
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`${this.id} did not receive message containing ${text}`);
	}

	close() {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(`${this.id} closed`));
		}
		this.pending.clear();
		this.proc.stdin.end();
		this.proc.kill("SIGTERM");
	}
}

const server = new PiBusServer({ host: "127.0.0.1", port: 0, heartbeatMs: 60_000 });
await server.listen();
const port = server.address().port;
console.log(`[pi-bus-smoke] broker listening on ${port}`);

const planner = new PiRpcAgent({ id: "planner-smoke", name: "Planner Smoke", port });
const worker = new PiRpcAgent({ id: "worker-smoke", name: "Worker Smoke", port });

try {
	const [plannerState, workerState] = await Promise.all([
		planner.send({ type: "get_state" }),
		worker.send({ type: "get_state" }),
	]);
	if (!plannerState.success || !workerState.success) throw new Error("RPC agents did not become ready");
	console.log("[pi-bus-smoke] two pi RPC agents connected");

	const plannerSend = await planner.send({ type: "prompt", message: "/bus-send agent.message hello-from-planner" });
	if (!plannerSend.success) throw new Error(`planner /bus-send failed: ${plannerSend.error}`);
	const workerMessage = await worker.waitForMessageText("hello-from-planner");
	console.log(`[pi-bus-smoke] worker received planner message (${workerMessage.role}/${workerMessage.customType ?? ""})`);
	const plannerSecondSend = await planner.send({ type: "prompt", message: "/bus-send agent.message hello-again-from-planner" });
	if (!plannerSecondSend.success) throw new Error(`planner second /bus-send failed: ${plannerSecondSend.error}`);
	await worker.waitForMessageText("hello-again-from-planner");
	console.log("[pi-bus-smoke] worker received a second pushed planner message");

	const workerSend = await worker.send({ type: "prompt", message: "/bus-send agent.reply ack-from-worker" });
	if (!workerSend.success) throw new Error(`worker /bus-send failed: ${workerSend.error}`);
	const plannerMessage = await planner.waitForMessageText("ack-from-worker");
	console.log(`[pi-bus-smoke] planner received worker message (${plannerMessage.role}/${plannerMessage.customType ?? ""})`);

	const workerDisconnect = await worker.send({ type: "prompt", message: "/bus-disconnect" });
	if (!workerDisconnect.success) throw new Error(`worker /bus-disconnect failed: ${workerDisconnect.error}`);
	const afterDisconnect = await planner.send({ type: "prompt", message: "/bus-send agent.message after-disconnect" });
	if (!afterDisconnect.success) throw new Error(`planner /bus-send after disconnect failed: ${afterDisconnect.error}`);
	await new Promise((resolve) => setTimeout(resolve, 500));
	if (await worker.hasMessageText("after-disconnect")) throw new Error("worker received a pushed event after disconnect");
	console.log("[pi-bus-smoke] disconnected worker did not receive pushed events");

	const workerConnect = await worker.send({ type: "prompt", message: "/bus-connect" });
	if (!workerConnect.success) throw new Error(`worker /bus-connect failed: ${workerConnect.error}`);
	await new Promise((resolve) => setTimeout(resolve, 500));
	const afterReconnect = await planner.send({ type: "prompt", message: "/bus-send agent.message after-reconnect" });
	if (!afterReconnect.success) throw new Error(`planner /bus-send after reconnect failed: ${afterReconnect.error}`);
	await worker.waitForMessageText("after-reconnect");
	console.log("[pi-bus-smoke] reconnected worker received pushed events again");

	console.log("[pi-bus-smoke] PASS");
} finally {
	planner.close();
	worker.close();
	await server.close();
}
