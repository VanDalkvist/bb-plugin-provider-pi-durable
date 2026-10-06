import test from "node:test";
import assert from "node:assert/strict";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import type { DurableView } from "../src/runner/runtime.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";

test("BBEventAdapter handles native AgentEvent stream correctly", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const dummyView = {} as DurableView;

	// 1. Run & turn start
	adapter.handleEvent({ type: "run_start", inputs: [] as any }, dummyView);
	adapter.handleEvent({ type: "turn_start" }, dummyView);

	assert.equal(emitted.some((e) => e.type === "agent_start"), true);
	assert.equal(emitted.some((e) => e.type === "turn_start"), true);

	// 2. Tool 1 starts
	adapter.handleEvent(
		{
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "bash",
			args: { command: "echo tool1" },
		},
		dummyView,
	);

	assert.equal(
		emitted.some(
			(e) =>
				e.type === "tool_execution_start" &&
				e.toolCallId === "call_1" &&
				(e.args as any)?.command === "echo tool1",
		),
		true,
	);

	// 3. Tool 1 updates
	adapter.handleEvent(
		{
			type: "tool_execution_update",
			toolCallId: "call_1",
			toolName: "bash",
			output: { append: "tool1 output\n" },
		},
		dummyView,
	);

	assert.equal(
		emitted.some(
			(e) =>
				e.type === "tool_execution_update" &&
				e.toolCallId === "call_1" &&
				e.partialResult === "tool1 output\n",
		),
		true,
	);

	// 4. Tool 1 ends
	adapter.handleEvent(
		{
			type: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "bash",
			entry: {
				model: [
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "bash",
						content: [{ type: "text", text: "tool1 output\n" }],
						isError: false,
					},
				],
			} as any,
		},
		dummyView,
	);

	assert.equal(
		emitted.some(
			(e) =>
				e.type === "tool_execution_end" &&
				e.toolCallId === "call_1" &&
				e.result === "tool1 output\n" &&
				e.isError === false,
		),
		true,
	);

	// 5. Tool 2 starts and completes
	adapter.handleEvent(
		{
			type: "tool_execution_start",
			toolCallId: "call_2",
			toolName: "bash",
			args: { command: "echo tool2" },
		},
		dummyView,
	);
	adapter.handleEvent(
		{
			type: "tool_execution_end",
			toolCallId: "call_2",
			toolName: "bash",
			entry: {
				model: [
					{
						role: "toolResult",
						toolCallId: "call_2",
						toolName: "bash",
						content: [{ type: "text", text: "tool2 output\n" }],
						isError: false,
					},
				],
			} as any,
		},
		dummyView,
	);

	const end1 = emitted.find((e) => e.type === "tool_execution_end" && e.toolCallId === "call_1");
	const end2 = emitted.find((e) => e.type === "tool_execution_end" && e.toolCallId === "call_2");
	assert.ok(end1);
	assert.ok(end2);
});
