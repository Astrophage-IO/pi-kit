import assert from "node:assert/strict";
import { test } from "node:test";
import { PiBusClient } from "../src/client.ts";
import { PiBusServer } from "../src/server.ts";

async function startServer(options: any = {}) {
	const server = new PiBusServer({ host: "127.0.0.1", port: 0, heartbeatMs: 60_000, ...options });
	await server.listen();
	const address = server.address() as any;
	return { server, port: address.port };
}

function onceEvent(emitter: any, eventName: string, timeoutMs = 1000): Promise<any> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			emitter.off(eventName, onEvent);
			reject(new Error(`Timed out waiting for ${eventName}`));
		}, timeoutMs);
		const onEvent = (event) => {
			clearTimeout(timeout);
			resolve(event);
		};
		emitter.once(eventName, onEvent);
	});
}

test("broadcasts events to subscribed peers", async () => {
	const { server, port } = await startServer();
	const a = new PiBusClient({ port, agent: { id: "a", name: "A" }, rooms: ["room"], topics: ["agent.*"], reconnect: false });
	const b = new PiBusClient({ port, agent: { id: "b", name: "B" }, rooms: ["room"], topics: ["agent.message"], reconnect: false });
	try {
		await Promise.all([a.connect(), b.connect()]);
		const eventPromise = onceEvent(b, "bus_event");
		const ack = await a.publish({ room: "room", topic: "agent.message", text: "hello" });
		const event = await eventPromise;
		assert.equal(ack.recipients, 1);
		assert.equal(event.text, "hello");
		assert.equal(event.from.agentId, "a");
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

		const eventPromise = onceEvent(a, "bus_event");
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
		const eventPromise = onceEvent(b, "bus_event");
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
