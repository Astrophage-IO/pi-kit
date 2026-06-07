import assert from "node:assert/strict";
import { test } from "bun:test";
import { canAutoTick, nextEmptyTicks, shouldDisarm, type AutoTickGate } from "../src/loop.ts";

function gate(overrides: Partial<AutoTickGate> = {}): AutoTickGate {
	return { status: "running", loopArmed: true, paused: false, stopRequested: false, idle: true, hasPending: false, ...overrides };
}

test("canAutoTick fires only when running, armed, idle, and not paused/stopped/pending", () => {
	assert.equal(canAutoTick(gate()), true);
	assert.equal(canAutoTick(gate({ loopArmed: false })), false);
	assert.equal(canAutoTick(gate({ status: "paused" })), false);
	assert.equal(canAutoTick(gate({ status: "done" })), false);
	assert.equal(canAutoTick(gate({ status: "stopped" })), false);
	assert.equal(canAutoTick(gate({ paused: true })), false);
	assert.equal(canAutoTick(gate({ stopRequested: true })), false);
	assert.equal(canAutoTick(gate({ idle: false })), false);
	assert.equal(canAutoTick(gate({ hasPending: true })), false);
});

test("nextEmptyTicks increments when iteration did not advance, resets when it did", () => {
	assert.equal(nextEmptyTicks(0, 5, 5), 1);
	assert.equal(nextEmptyTicks(2, 5, 5), 3);
	assert.equal(nextEmptyTicks(2, 5, 6), 0);
	// a stale read (iteration below last seen) is still treated as no progress
	assert.equal(nextEmptyTicks(1, 5, 4), 2);
});

test("shouldDisarm trips at the configured ceiling", () => {
	assert.equal(shouldDisarm(2, 3), false);
	assert.equal(shouldDisarm(3, 3), true);
	assert.equal(shouldDisarm(4, 3), true);
});
