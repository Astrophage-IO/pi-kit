#!/usr/bin/env node
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { PiBusServer } from "../src/server.ts";

const cwd = new URL("..", import.meta.url).pathname;

type JsonRecord = Record<string, unknown>;
type RpcResponse = JsonRecord & { success?: boolean; error?: string; data?: unknown };
type RpcMessage = JsonRecord;

interface PendingRpc {
	resolve(value: RpcResponse): void;
	reject(error: Error): void;
	timeout: ReturnType<typeof setTimeout>;
}

function attachJsonlReader(stream: Readable, onLine: (line: string) => void): void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	stream.on("data", (chunk: Buffer | string) => {
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
	readonly id: string;
	readonly name: string;
	readonly proc: ReturnType<typeof spawn>;
	readonly events: RpcMessage[] = [];
	readonly pending = new Map<string, PendingRpc>();
	stderr = "";

	constructor({ id, name, port }: { id: string; name: string; port: number }) {
		this.id = id;
		this.name = name;
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
		if (!this.proc.stdout || !this.proc.stderr || !this.proc.stdin) throw new Error("pi RPC child did not expose stdio pipes");
		this.proc.stderr.on("data", (chunk: Buffer | string) => {
			this.stderr += chunk.toString();
		});
		attachJsonlReader(this.proc.stdout, (line) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return;
			}
			if (!isRecord(parsed)) return;
			this.events.push(parsed);
			if (parsed.type === "response" && typeof parsed.id === "string") {
				const pending = this.pending.get(parsed.id);
				if (!pending) return;
				this.pending.delete(parsed.id);
				clearTimeout(pending.timeout);
				pending.resolve(parsed as RpcResponse);
			}
		});
	}

	send(command: Record<string, unknown>, timeoutMs = 15_000): Promise<RpcResponse> {
		const id = typeof command.id === "string" ? command.id : `${this.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${this.id} RPC timeout for ${String(command.type)}\n${this.stderr}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			this.proc.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	async getMessages(): Promise<RpcMessage[]> {
		const response = await this.send({ type: "get_messages" });
		if (!response.success) throw new Error(`${this.id} get_messages failed: ${response.error}`);
		const data = isRecord(response.data) ? response.data : {};
		return Array.isArray(data.messages) ? data.messages.filter(isRecord) : [];
	}

	async hasMessageText(text: string): Promise<boolean> {
		const messages = await this.getMessages();
		return messages.some((message) => JSON.stringify(message).includes(text));
	}

	async waitForMessageText(text: string, timeoutMs = 5_000): Promise<RpcMessage> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const messages = await this.getMessages();
			const found = messages.find((message) => JSON.stringify(message).includes(text));
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`${this.id} did not receive message containing ${text}`);
	}

	close(): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(`${this.id} closed`));
		}
		this.pending.clear();
		this.proc.stdin?.end();
		this.proc.kill("SIGTERM");
	}
}

const server = new PiBusServer({ host: "127.0.0.1", port: 0, heartbeatMs: 60_000 });
await server.listen();
const address = server.address();
if (!address || typeof address === "string") throw new Error("PiBus smoke server did not bind a TCP address");
const port = address.port;
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
	console.log(`[pi-bus-smoke] worker received planner message (${String(workerMessage.role)}/${String(workerMessage.customType ?? "")})`);
	const plannerSecondSend = await planner.send({ type: "prompt", message: "/bus-send agent.message hello-again-from-planner" });
	if (!plannerSecondSend.success) throw new Error(`planner second /bus-send failed: ${plannerSecondSend.error}`);
	await worker.waitForMessageText("hello-again-from-planner");
	console.log("[pi-bus-smoke] worker received a second pushed planner message");

	const workerSend = await worker.send({ type: "prompt", message: "/bus-send agent.reply ack-from-worker" });
	if (!workerSend.success) throw new Error(`worker /bus-send failed: ${workerSend.error}`);
	const plannerMessage = await planner.waitForMessageText("ack-from-worker");
	console.log(`[pi-bus-smoke] planner received worker message (${String(plannerMessage.role)}/${String(plannerMessage.customType ?? "")})`);

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

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
