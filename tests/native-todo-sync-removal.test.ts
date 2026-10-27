import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { SessionSubagentHandler } from "../src/host/session-subagent-handler.ts";
import { wireFixture } from "./fixtures/wire.ts";
import type { BBPlanStep } from "../src/contracts/wire-lifecycle.ts";
import type { RuntimeGraphSnapshot } from "../src/runtime-graph/types.ts";

function createMockSnapshot(): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "sess-todo-removal", rootConversationId: "1", buildId: "pi-1.4" },
		observation: { epoch: "ep-1", revision: 1, observedAt: Date.now(), completeness: "complete" },
		nodes: {
			"1": {
				id: 1,
				kind: "pi.tool",
				conversationId: 1,
				background: false,
				abortRequested: false,
				state: { status: "running" },
				label: "root-task",
			},
			"2": {
				id: 2,
				kind: "pi.tool",
				conversationId: 2,
				background: false,
				abortRequested: false,
				state: { status: "running" },
				label: "child-task",
			},
		},
		conversations: {
			"1": { id: 1 },
			"2": { id: 2, owner: { conversationId: 1, taskId: 1 } },
		},
		receipts: [],
		stats: { liveCount: 2, terminalCount: 0, totalCount: 2 },
	};
}

test("native-todo-sync-removal: tasks_snapshot produces zero thread deltas and no planSteps mutation", () => {
	const translator = new DeltaTranslator();
	const steps: BBPlanStep[] = [
		{ step: "#1 assistant turn", status: "active" },
		{ step: "  #2 bash: echo test", status: "completed" },
	];

	const deltas = translator.translate(
		wireFixture("tasks_snapshot", { type: "tasks_snapshot", steps }),
		{ threadId: "thr-test-parent" },
	);

	assert.deepEqual(deltas, [], "tasks_snapshot must emit no deltas (no planSteps, no items, no channel mutation)");
	const hasPlanSteps = deltas.some((d: any) => d.item?.type === "planSteps" || d.key?.channel === "pi-durable-tasks");
	assert.equal(hasPlanSteps, false, "Must never emit planSteps item or pi-durable-tasks channel");
});

test("native-todo-sync-removal: runtime_graph_snapshot continues to propagate extension.state", () => {
	const translator = new DeltaTranslator();
	const snapshot = createMockSnapshot();
	const deltas = translator.translate(
		wireFixture("runtime_graph_snapshot", { type: "runtime_graph_snapshot", snapshot }),
		{ threadId: "thr-test-parent" },
	);

	assert.equal(deltas.length, 1);
	const delta = deltas[0]!;
	assert.equal(delta.kind, "extension.state");
	assert.equal(delta.extensionKind, "provider-pi-durable/runtime-graph");
	assert.equal(threadDeltaSchema.safeParse(delta).success, true);
});

test("native-todo-sync-removal: standard tool and chat deltas propagate untouched", () => {
	const translator = new DeltaTranslator();

	// Message update (chat delta)
	const msgDeltas = translator.translate(
		wireFixture("message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello world" },
		}),
		{ threadId: "thr-test-parent" },
	);
	assert.equal(msgDeltas.length, 1);
	assert.equal(msgDeltas[0]?.kind, "item.textDelta");

	// Tool execution deltas
	const toolStartDeltas = translator.translate(
		wireFixture("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "ls" },
		}),
		{ threadId: "thr-test-parent" },
	);
	assert.equal(toolStartDeltas.length, 1);
	assert.equal(toolStartDeltas[0]?.kind, "item.open");

	const toolEndDeltas = translator.translate(
		wireFixture("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: "ok",
			isError: false,
		}),
		{ threadId: "thr-test-parent" },
	);
	assert.equal(toolEndDeltas.length, 1);
	assert.equal(toolEndDeltas[0]?.kind, "item.close");
});

test("native-todo-sync-removal: subagent child routing leaves native todo untouched while routing graph/tools", () => {
	const handler = new SessionSubagentHandler();
	const notifications: Array<{ method: string; params: any }> = [];
	const fakeSession = {
		options: { threadId: "thr_parent", cwd: "/tmp", providerOptions: {} },
		getThreadIdForConversation: (id: string | number) => (String(id) === "2" ? "thr_child_2" : undefined),
		registerThread: () => {},
	};

	handler.markActive(2, { task: "child task" });

	// 1. Deliver tasks_snapshot targeted at child conversation
	const childTaskSnapshotEvent = wireFixture("tasks_snapshot", {
		type: "tasks_snapshot",
		conversationId: 2 as any,
		steps: [{ step: "#2 subagent worker", status: "active" }],
	});
	handler.handleEvent(childTaskSnapshotEvent, fakeSession as any, (method, params) => {
		notifications.push({ method, params });
	});

	// Child thread must NOT receive any planSteps notifications
	const childPlanNotifications = notifications.filter(
		(n) => n.params?.deltas?.some((d: any) => d.item?.type === "planSteps" || d.key?.channel === "pi-durable-tasks"),
	);
	assert.equal(childPlanNotifications.length, 0, "Child thread must receive no planSteps or todo mutations");

	// 2. Deliver runtime_graph_snapshot (should fan out to child 2)
	const snapshot = createMockSnapshot();
	const graphEvent = wireFixture("runtime_graph_snapshot", {
		type: "runtime_graph_snapshot",
		snapshot,
	});
	handler.handleEvent(graphEvent, fakeSession as any, (method, params) => {
		notifications.push({ method, params });
	});

	const childGraphNotification = notifications.find(
		(n) => n.params?.threadId === "thr_child_2" && n.params?.deltas?.[0]?.kind === "extension.state",
	);
	assert.ok(childGraphNotification, "Child thread must receive runtime_graph_snapshot as extension.state");
});
