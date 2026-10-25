import test from "node:test";
import assert from "node:assert/strict";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import { BBChildEventAdapter } from "../src/runner/bridge/bb-child-event-adapter.ts";
import { extractCanonicalToolDetails } from "../src/runner/bridge/native-tool-result.ts";

test("Slice 3: BBEventAdapter routes nested tool end cleanly with projector", () => {
	const wireEvents: any[] = [];
	const adapter = new BBEventAdapter((ev) => wireEvents.push(ev));

	adapter.handleEvent({
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "read",
		args: { path: "file.txt" },
	} as any, null as any);

	adapter.handleEvent({
		type: "tool_execution_update",
		toolCallId: "call-1",
		toolName: "read",
		output: { append: "file content" },
	} as any, null as any);

	adapter.handleEvent({
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "read",
		result: {
			taskId: "t1" as any,
			structuredOutput: "file content",
			isError: false,
			diagnostics: [],
		},
	} as any, null as any);

	const endWire = wireEvents.find((e) => e.type === "tool_execution_end");
	assert.ok(endWire);
	assert.equal(endWire.isError, false, "Nested tool end must not be marked as error");
	assert.equal(endWire.result, "file content");
});

test("Remediation P1 RED: BBChildEventAdapter seeds snapshot with PREFIXED keys and resets on run_start", () => {
	const wireEvents: any[] = [];
	const parentRef = "parent-subagent-call";
	const childAdapter = new BBChildEventAdapter((ev) => wireEvents.push(ev), parentRef, 88);

	// 1. Initial snapshot arrives with unprefixed child tool slots
	childAdapter.handleEvent({
		type: "snapshot",
		entries: [],
		tools: [
			{ callId: "c_tool_1", output: "seeded child output" } as any,
		],
		nestedTools: [],
	} as any, null as any);

	// 2. Child tool update arrives with child callId (adapter will prefix it with parentRef)
	childAdapter.handleEvent({
		type: "tool_execution_update",
		toolCallId: "c_tool_1",
		toolName: "bash",
		output: { append: " + more" },
	} as any, null as any);

	const updateWire = wireEvents.find((e) => e.type === "tool_execution_update");
	assert.ok(updateWire, "Update event should be emitted");
	assert.equal(
		updateWire.partialResult,
		"seeded child output + more",
		"Child adapter must prefix seeded snapshot keys so that subsequent updates match the seeded buffer",
	);

	// 3. Child run_start should reset scoped state
	childAdapter.handleEvent({ type: "run_start" } as any, null as any);

	// 4. Update after run_start should start fresh
	childAdapter.handleEvent({
		type: "tool_execution_update",
		toolCallId: "c_tool_1",
		toolName: "bash",
		output: { append: "fresh" },
	} as any, null as any);

	const secondUpdate = wireEvents.filter((e) => e.type === "tool_execution_update")[1];
	assert.equal(secondUpdate?.partialResult, "fresh", "run_start in child adapter must clear previous output buffer");
});

test("Remediation P1 RED: BBEventAdapter clears scoped projection state on run_end", () => {
	const wireEvents: any[] = [];
	const adapter = new BBEventAdapter((ev) => wireEvents.push(ev));

	const dummyView = { conversation: { entries: [] } } as any;

	// 1. Tool starts and streams partial output
	adapter.handleEvent({
		type: "tool_execution_update",
		toolCallId: "call_turn_1",
		toolName: "bash",
		output: { append: "turn 1 output" },
	} as any, dummyView);

	// 2. Run ends without tool_execution_end (e.g. abort or fault)
	adapter.handleEvent({
		type: "run_end",
		inputs: [],
	} as any, dummyView);

	// 3. New run begins, tool with same callId starts
	adapter.handleEvent({
		type: "tool_execution_update",
		toolCallId: "call_turn_1",
		toolName: "bash",
		output: { append: "turn 2 output" },
	} as any, dummyView);

	const updates = wireEvents.filter((e) => e.type === "tool_execution_update");
	assert.equal(updates.length, 2);
	assert.equal(
		updates[1].partialResult,
		"turn 2 output",
		"Root adapter must clear projection state on run_end so next turn does not inherit old buffer",
	);
});

test("Slice 3: BBChildEventAdapter prefixes toolCallId and preserves conversationId", () => {
	const wireEvents: any[] = [];
	const childAdapter = new BBChildEventAdapter(
		(ev) => wireEvents.push(ev),
		"parent-subagent-call",
		77,
	);

	childAdapter.handleEvent({
		type: "tool_execution_start",
		toolCallId: "child-tool-1",
		toolName: "bash",
		args: { command: "ls" },
	} as any, null as any);

	childAdapter.handleEvent({
		type: "tool_execution_end",
		toolCallId: "child-tool-1",
		toolName: "bash",
		result: {
			taskId: "t2" as any,
			structuredOutput: "dir contents",
			isError: false,
			diagnostics: [],
		},
	} as any, null as any);

	const endWire = wireEvents.find((e) => e.type === "tool_execution_end");
	assert.ok(endWire);
	assert.equal(endWire.toolCallId, "parent-subagent-call:child-tool-1");
	assert.equal(endWire.parentRef, "parent-subagent-call");
	assert.equal(endWire.conversationId, 77);
	assert.equal(endWire.isError, false);
	assert.equal(endWire.result, "dir contents");
});

test("Slice 3: Subagent terminal discovery resolves conversationId from canonical details", () => {
	const modelEvent = {
		type: "tool_execution_end",
		entry: {
			id: "e1",
			conversationId: "root",
			kind: "toolResult",
			data: { diagnostics: [] },
			model: [
				{
					role: "toolResult",
					details: { conversationId: 101, task: "child task" },
				},
			],
		},
	};
	const canonicalModel = extractCanonicalToolDetails(modelEvent) as any;
	assert.equal(canonicalModel?.conversationId, 101);

	const nestedEvent = {
		type: "tool_execution_end",
		result: {
			taskId: "t3",
			details: { conversationId: 102, task: "nested child task" },
		},
	};
	const canonicalNested = extractCanonicalToolDetails(nestedEvent) as any;
	assert.equal(canonicalNested?.conversationId, 102);
});
