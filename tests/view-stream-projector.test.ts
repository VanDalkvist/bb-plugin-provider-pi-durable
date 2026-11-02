import test from "node:test";
import assert from "node:assert/strict";
import { ViewStreamProjector } from "../src/runner/bridge/view-stream-projector.ts";
import type { RunnerEvent } from "../src/runner/bridge/contracts.ts";

test("ViewStreamProjector: synthesizes agent_start and turn_start on live run transition", () => {
	const emitted: RunnerEvent[] = [];
	const projector = new ViewStreamProjector((evt) => emitted.push(evt));

	// Simulate initial view update with live run
	projector.project({
		conversationId: "root",
		run: { id: "run-1", state: "running" },
		entries: [],
	});

	assert.ok(emitted.length >= 2, "Expected agent_start and turn_start");
	assert.equal(emitted[0]?.type, "agent_start");
	assert.equal(emitted[1]?.type, "turn_start");
});

test("ViewStreamProjector: synthesizes turn_end and agent_end when live run completes", () => {
	const emitted: RunnerEvent[] = [];
	const projector = new ViewStreamProjector((evt) => emitted.push(evt));

	// Start run
	projector.project({
		conversationId: "root",
		run: { id: "run-1", state: "running" },
		entries: [],
	});

	assert.equal(emitted.length, 2);

	// End run
	projector.project({
		conversationId: "root",
		run: null,
		entries: [],
	});

	assert.equal(emitted.length, 4);
	assert.equal(emitted[2]?.type, "turn_end");
	assert.equal(emitted[3]?.type, "agent_end");
});
