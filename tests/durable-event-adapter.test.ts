import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DurableEventAdapter } from "../src/runner/bridge/durable-event-adapter.ts";
import { DurableChildEventAdapter } from "../src/runner/bridge/durable-child-event-adapter.ts";
import type { RunnerEvent, AgentStartEvent, TurnStartEvent, TurnEndEvent, AgentEndEvent } from "../src/contracts/runner-event.ts";
import type { AssistantMessage, AssistantMessageUsage } from "../src/contracts/wire-message.ts";
import type { PlanStep } from "../src/contracts/wire-lifecycle.ts";
import { viewFixture } from "./fixtures/durable.ts";

test("DurableEventAdapter instantiates and translates native FSM events into canonical RunnerEvent stream", () => {
	const emitted: RunnerEvent[] = [];
	const adapter = new DurableEventAdapter((evt) => emitted.push(evt));
	const dummyView = viewFixture({});

	// 1. Run & turn start
	adapter.handleEvent({ type: "run_start", inputs: [] as any }, dummyView);
	adapter.handleEvent({ type: "turn_start" }, dummyView);
	assert.equal(emitted.some((e) => e.type === "agent_start"), true);
	assert.equal(emitted.some((e) => e.type === "turn_start"), true);

	// 2. Thinking & text streaming
	adapter.handleEvent({
		type: "message_update",
		changes: [{ type: "thinking_delta", delta: "pondering..." }],
	} as any, dummyView);
	assert.equal(emitted.some((e) => e.type === "message_update" && (e as any).assistantMessageEvent?.type === "thinking_delta"), true);

	adapter.handleEvent({
		type: "message_update",
		changes: [{ type: "text_delta", delta: "Hello world" }],
	} as any, dummyView);
	assert.equal(emitted.some((e) => e.type === "message_update" && (e as any).assistantMessageEvent?.type === "thinking_end"), true);
	assert.equal(emitted.some((e) => e.type === "message_update" && (e as any).assistantMessageEvent?.type === "text_delta"), true);

	// 3. Tool execution
	adapter.handleEvent({
		type: "tool_execution_start",
		toolCallId: "call_1",
		toolName: "bash",
		args: { command: "echo tool1" },
	}, dummyView);
	assert.equal(emitted.some((e) => e.type === "tool_execution_start" && e.toolCallId === "call_1"), true);

	adapter.handleEvent({
		type: "tool_execution_end",
		toolCallId: "call_1",
		toolName: "bash",
		entry: {
			model: [{ isError: false, content: "tool output" }],
		},
	} as any, dummyView);
	assert.equal(emitted.some((e) => e.type === "tool_execution_end" && e.toolCallId === "call_1"), true);

	// 4. Message end, turn end, run end
	adapter.handleEvent({
		type: "message_end",
		entry: {
			model: [{ role: "assistant", content: [{ type: "text", text: "Hello world" }], stopReason: "stop" }],
		},
	} as any, dummyView);
	assert.equal(emitted.some((e) => e.type === "message_end"), true);

	adapter.handleEvent({ type: "turn_end" }, dummyView);
	assert.equal(emitted.some((e) => e.type === "turn_end"), true);

	adapter.handleEvent({ type: "run_end", inputs: [] } as any, dummyView);
	assert.equal(emitted.some((e) => e.type === "agent_end"), true);
});

test("createChildAdapter creates DurableChildEventAdapter and decorates child events", () => {
	const emitted: RunnerEvent[] = [];
	const adapter = new DurableEventAdapter((evt) => emitted.push(evt));
	const childAdapter = adapter.createChildAdapter("parent_call_99", "conv_42");

	assert.ok(childAdapter instanceof DurableChildEventAdapter);

	childAdapter.handleEvent({
		type: "tool_execution_start",
		toolCallId: "child_tool_1",
		toolName: "bash",
		args: { command: "ls" },
	} as any);

	const childToolStart = emitted.find((e) => e.type === "tool_execution_start");
	assert.ok(childToolStart);
	assert.equal((childToolStart as any).parentRef, "parent_call_99");
	assert.equal((childToolStart as any).toolCallId, "parent_call_99:child_tool_1");
	assert.equal((childToolStart as any).conversationId, "conv_42");
});

test("Runner and bridge wire contracts have zero BB* prefixes", () => {
	const contractsDir = path.resolve(import.meta.dirname, "../src/contracts");
	const bridgeDir = path.resolve(import.meta.dirname, "../src/runner/bridge");

	const filesToCheck = [
		path.join(contractsDir, "runner-event.ts"),
		path.join(contractsDir, "wire-message.ts"),
		path.join(contractsDir, "wire-lifecycle.ts"),
		path.join(contractsDir, "wire-tool.ts"),
		path.join(bridgeDir, "contracts.ts"),
	];

	for (const file of filesToCheck) {
		const content = fs.readFileSync(file, "utf8");
		const matches = content.match(/\bBB[A-Z][A-Za-z0-9_]*\b/g);
		assert.equal(
			matches,
			null,
			`File ${path.basename(file)} must not contain any BB* type identifiers, found: ${matches?.join(", ")}`,
		);
	}
});
