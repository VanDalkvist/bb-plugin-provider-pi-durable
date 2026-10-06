import test from "node:test";
import assert from "node:assert/strict";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import type { DurableView } from "../src/runner/runtime.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";

test("BBEventAdapter emits tool_execution_end immediately when tool vanishes from live.tools", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));

	// State 1: Tool call 1 is running
	const view1: DurableView = {
		conversation: {
			id: 1,
			docs: {
				"pi.live": {
					run: { taskId: 10, inputs: [1] },
					tools: [
						{
							callId: "call_1",
							name: "bash",
							status: "running",
							output: "executing...",
						},
					],
				},
			},
			entries: [],
		},
	};

	adapter.sync(view1);

	assert.equal(emitted.some((e) => e.type === "tool_execution_start" && e.toolCallId === "call_1"), true);
	assert.equal(emitted.some((e) => e.type === "tool_execution_end" && e.toolCallId === "call_1"), false);

	// State 2: Tool call 1 is done, entry is committed, and live.tools is cleared, BUT run is still busy!
	const view2: DurableView = {
		conversation: {
			id: 1,
			docs: {
				"pi.live": {
					run: { taskId: 10, inputs: [1] },
				},
			},
			entries: [
				{
					id: 100,
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolCallId: "call_1",
							toolName: "bash",
							content: "output 1",
							isError: false,
						},
					],
				},
			],
		},
	};

	adapter.sync(view2);

	// CRITICAL ASSERTION: tool_execution_end MUST have been emitted immediately upon view2 sync!
	const endEvent = emitted.find((e) => e.type === "tool_execution_end" && e.toolCallId === "call_1");
	assert.ok(endEvent, "tool_execution_end must be emitted immediately when tool vanishes or result is committed");
	assert.equal(endEvent.toolCallId, "call_1");
	assert.equal(endEvent.result, "output 1");
	assert.equal(endEvent.isError, false);
});

test("BBEventAdapter emits sequential start and end events for multi-tool turn", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));

	// Tool 1 starts
	adapter.sync({
		conversation: {
			id: 1,
			docs: {
				"pi.live": {
					run: { taskId: 10, inputs: [1] },
					tools: [{ callId: "c1", name: "bash", status: "running" }],
				},
			},
			entries: [],
		},
	});

	// Tool 1 finishes, Tool 2 starts in next round
	adapter.sync({
		conversation: {
			id: 1,
			docs: {
				"pi.live": {
					run: { taskId: 10, inputs: [1] },
					tools: [{ callId: "c2", name: "bash", status: "running" }],
				},
			},
			entries: [
				{
					id: 1,
					kind: "pi.tool-result",
					model: [{ role: "toolResult", toolCallId: "c1", content: "res1" }],
				},
			],
		},
	});

	// Tool 1 must be ended, Tool 2 started
	const c1End = emitted.find((e) => e.type === "tool_execution_end" && e.toolCallId === "c1");
	const c2Start = emitted.find((e) => e.type === "tool_execution_start" && e.toolCallId === "c2");
	const c2End = emitted.find((e) => e.type === "tool_execution_end" && e.toolCallId === "c2");

	assert.ok(c1End, "Tool 1 must end when Tool 2 starts");
	assert.ok(c2Start, "Tool 2 must start");
	assert.equal(c2End, undefined, "Tool 2 must not be ended yet");

	// Tool 2 finishes
	adapter.sync({
		conversation: {
			id: 1,
			docs: {
				"pi.live": {
					run: { taskId: 10, inputs: [1] },
				},
			},
			entries: [
				{
					id: 1,
					kind: "pi.tool-result",
					model: [{ role: "toolResult", toolCallId: "c1", content: "res1" }],
				},
				{
					id: 2,
					kind: "pi.tool-result",
					model: [{ role: "toolResult", toolCallId: "c2", content: "res2" }],
				},
			],
		},
	});

	const c2EndFinal = emitted.find((e) => e.type === "tool_execution_end" && e.toolCallId === "c2");
	assert.ok(c2EndFinal, "Tool 2 must end when result is committed");
});
