import assert from "node:assert/strict";
import net from "node:net";
import { test } from "bun:test";
import { PiBusClient } from "../src/client.ts";
import { PiBusServer, type PiBusServerOptions } from "../src/server.ts";
import { PROTOCOL_VERSION, type BusEvent } from "../src/protocol.ts";
import { decodeFrames, encodeFrame } from "../src/wire.ts";

async function startServer(options: PiBusServerOptions = {}): Promise<{ server: PiBusServer; port: number }> {
	const server = new PiBusServer({ host: "127.0.0.1", port: 0, heartbeatMs: 60_000, ...options });
	await server.listen();
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test PiBus server did not bind a TCP address");
	return { server, port: address.port };
}

function onceBusEvent(client: PiBusClient, timeoutMs = 1000): Promise<BusEvent> {
	return new Promise((resolve, reject) => {
		const onEvent = (event: BusEvent) => {
			clearTimeout(timeout);
			resolve(event);
		};
		const timeout = setTimeout(() => {
			client.off("bus_event", onEvent);
			reject(new Error("Timed out waiting for bus_event"));
		}, timeoutMs);
		client.once("bus_event", onEvent);
	});
}

function onceReconnectFailed(client: PiBusClient, timeoutMs = 1000): Promise<Error> {
	return new Promise((resolve, reject) => {
		const onEvent = (error: Error) => {
			clearTimeout(timeout);
			resolve(error);
		};
		const timeout = setTimeout(() => {
			client.off("reconnect_failed", onEvent);
			reject(new Error("Timed out waiting for reconnect_failed"));
		}, timeoutMs);
		client.once("reconnect_failed", onEvent);
	});
}

test("broadcasts events to subscribed peers", async () => {
	const { server, port } = await startServer();
	const a = new PiBusClient({ port, agent: { id: "a", name: "A" }, rooms: ["room"], topics: ["agent.*"], reconnect: false });
	const b = new PiBusClient({ port, agent: { id: "b", name: "B" }, rooms: ["room"], topics: ["agent.message"], reconnect: false });
	try {
		await Promise.all([a.connect(), b.connect()]);
		const eventPromise = onceBusEvent(b);
		const ack = await a.publish({ room: "room", topic: "agent.message", text: "hello" });
		const event = await eventPromise;
		assert.equal(ack.recipients, 1);
		assert.equal(event.text, "hello");
		assert.equal(event.from?.agentId, "a");
	} finally {
		a.close();
		b.close();
		await server.close();
	}
});

test("does not echo to sender unless includeSelf is true", async () => {
	const { server, port } = await startServer();
	const a = new PiBusClient({ port, agent: { id: "a" }, rooms: ["room"], topics: ["*"], reconnect: false });
	try {
		await a.connect();
		let received = false;
		a.once("bus_event", () => (received = true));
		let ack = await a.publish({ room: "room", topic: "agent.message", text: "silent" });
		assert.equal(ack.recipients, 0);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(received, false);

		const eventPromise = onceBusEvent(a);
		ack = await a.publish({ room: "room", topic: "agent.message", text: "echo" }, { includeSelf: true });
		const event = await eventPromise;
		assert.equal(ack.recipients, 1);
		assert.equal(event.text, "echo");
	} finally {
		a.close();
		await server.close();
	}
});

test("direct targets bypass topic subscription", async () => {
	const { server, port } = await startServer();
	const a = new PiBusClient({ port, agent: { id: "a" }, rooms: ["room"], topics: ["agent.message"], reconnect: false });
	const b = new PiBusClient({ port, agent: { id: "b", name: "Bee" }, rooms: ["other"], topics: ["different.topic"], reconnect: false });
	try {
		await Promise.all([a.connect(), b.connect()]);
		const eventPromise = onceBusEvent(b);
		const ack = await a.publish({ room: "room", topic: "private.question", target: "Bee", text: "ping" });
		const event = await eventPromise;
		assert.equal(ack.recipients, 1);
		assert.deepEqual(event.target, ["Bee"]);
		assert.equal(event.text, "ping");
	} finally {
		a.close();
		b.close();
		await server.close();
	}
});

test("history and peers commands return current state", async () => {
	const { server, port } = await startServer();
	const a = new PiBusClient({ port, agent: { id: "a", name: "A" }, rooms: ["room"], topics: ["*"], reconnect: false });
	const b = new PiBusClient({ port, agent: { id: "b", name: "B" }, rooms: ["room"], topics: ["*"], reconnect: false });
	try {
		await Promise.all([a.connect(), b.connect()]);
		await a.publish({ room: "room", topic: "agent.message", text: "one" });
		await a.publish({ room: "room", topic: "agent.status", text: "two" });
		const history = await b.requestHistory({ room: "room", topic: "agent.*", limit: 10 });
		assert.equal(history.events.length, 2);
		assert.deepEqual(history.events.map((event) => event.text), ["one", "two"]);
		const peers = await b.requestPeers();
		assert.equal(peers.peers.length, 2);
		assert.deepEqual(peers.peers.map((peer) => peer.agentId).sort(), ["a", "b"]);
	} finally {
		a.close();
		b.close();
		await server.close();
	}
});

test("rejects clients with an invalid token", async () => {
	const { server, port } = await startServer({ token: "secret" });
	const bad = new PiBusClient({ port, token: "wrong", agent: { id: "bad" }, reconnect: false });
	try {
		await assert.rejects(() => bad.connect(), /Invalid PiBus token/);
	} finally {
		bad.close();
		await server.close();
	}
});

test("concurrent connect callers reject together on handshake failure", async () => {
	const { server, port } = await startServer({ token: "secret" });
	const bad = new PiBusClient({ port, token: "wrong", agent: { id: "bad" }, reconnect: false });
	try {
		const first = bad.connect();
		const second = bad.connect();
		await assert.rejects(() => first, /Invalid PiBus token/);
		await assert.rejects(() => second, /Invalid PiBus token/);
	} finally {
		bad.close();
		await server.close();
	}
});

test("reconnect gives up after configured attempts", async () => {
	const { server, port } = await startServer();
	await server.close();
	const client = new PiBusClient({
		port,
		agent: { id: "retry" },
		reconnect: true,
		reconnectMinMs: 5,
		reconnectMaxMs: 5,
		reconnectMaxAttempts: 2,
		reconnectJitter: 0,
	});
	try {
		const failed = onceReconnectFailed(client);
		await assert.rejects(() => client.connect());
		const error = await failed;
		assert.match(error.message, /reconnect attempts exhausted/);
	} finally {
		client.close();
	}
});

test("server closes unauthenticated sockets after hello timeout", async () => {
	const { server, port } = await startServer({ helloTimeoutMs: 20 });
	const socket = net.connect({ host: "127.0.0.1", port });
	try {
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("socket did not close after hello timeout")), 1000);
			socket.on("close", () => {
				clearTimeout(timeout);
				resolve();
			});
			socket.on("error", reject);
		});
	} finally {
		socket.destroy();
		await server.close();
	}
});

test("protobuf wire decodes multiple length-prefixed frames", () => {
	const bytes = Buffer.concat([
		encodeFrame("ping", { id: "one", now: "t1" }),
		encodeFrame("hello", { id: "two", protocol: PROTOCOL_VERSION, agent: { id: "a", name: "A" }, rooms: ["room"], topics: ["*"] }),
	]);
	const decoded = decodeFrames(bytes, 1024 * 1024);
	assert.equal(decoded.rest.length, 0);
	assert.equal(decoded.frames.length, 2);
	assert.equal(decoded.frames[0]?.body.case, "ping");
	assert.equal(decoded.frames[1]?.body.case, "hello");
});
