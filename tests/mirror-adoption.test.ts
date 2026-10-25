import test from "node:test";
import assert from "node:assert/strict";
import * as adoption from "../src/host/mirror-adoption.ts";

test("mirror decision is pure and ordinary follow-up is not adopted", () => {
	const state = Object.freeze({ task: "work on file", status: "running" as const, initialTurnConsumed: false });
	assert.equal(adoption.decideMirrorAdoption(state, "work on file"), "running");
	assert.equal(adoption.decideMirrorAdoption(state, "different follow-up"), "ordinary");
	assert.equal(adoption.decideMirrorAdoption({ ...state, initialTurnConsumed: true }, "work on file"), "ordinary");
	assert.equal(adoption.decideMirrorAdoption(undefined, "anything"), "ordinary");
});

test("completed adoption reports existing terminal flush instead of inventing another boundary", () => {
	const calls: string[] = [];
	const result = adoption.adoptInitialMirror({ task: "work", status: "completed" }, "work", {
		markConsumed: () => calls.push("mark"), register: () => { calls.push("register"); return true; },
		output: () => "done", consumeCompleted: () => calls.push("consume"),
	});
	assert.deepEqual(result, { kind: "completed", terminalEmitted: true, outputText: "done" });
	assert.deepEqual(calls, ["mark", "register", "consume"]);
});

test("running adoption attaches once; ordinary input does not invoke mirror operations", () => {
	const calls: string[] = [];
	const port = {
		markConsumed: () => { calls.push("mark"); }, register: () => { calls.push("register"); return false; },
		output: () => "", consumeCompleted: () => { assert.fail("running mirror consumed"); },
	};
	assert.deepEqual(adoption.adoptInitialMirror({ task: "work", status: "running" }, "work", port), { kind: "running" });
	assert.deepEqual(calls, ["mark", "register"]);
	assert.deepEqual(adoption.adoptInitialMirror(undefined, "later", port), { kind: "ordinary" });
	assert.deepEqual(calls, ["mark", "register"]);
});
