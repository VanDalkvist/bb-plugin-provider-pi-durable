import test from "node:test";
import assert from "node:assert/strict";
import { PiThreadSession } from "../src/host/session.ts";
import type { RunnerEvent } from "../src/host/types.ts";

test("PiThreadSession isolates subagent events to child thread while parent receives delegation summary only", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

	const session = new PiThreadSession(
		{
			threadId: "thr_parent",
			providerThreadId: "pi_durable_root",
			sessionFilePath: "/tmp/fake-dual.sqlite",
			sessionDir: "/tmp",
			extensionPath: "/tmp/ext",
			scratchDir: "/tmp/scratch",
		},
		(method, params) => notifications.push({ method, params }),
	);

	try {
		session.registerThread("thr_child", "2");
		session.markSubagentActive("2", { task: "Audit", parentToolCallId: "call_sub_1" });

		const childEvent: RunnerEvent = {
			type: "message_update",
			conversationId: 2,
			parentRef: "call_sub_1",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Checking tables...",
			},
		};

		await (session as any).handleRunnerEvent(childEvent);

		// 1. Parent thread must NOT receive child detail text deltas (approved UX: delegation summary only)
		const parentNotifs = notifications.filter((n) => n.params.threadId === "thr_parent");
		assert.equal(parentNotifs.length, 0, "Parent thread must not receive child text deltas");

		// 2. Child thread received root delta without parentRef (for standalone child chat)
		const childNotifs = notifications.filter((n) => n.params.threadId === "thr_child");
		assert.ok(childNotifs.length > 0, "Child thread must receive root deltas");
		const childDelta = (childNotifs[0].params.deltas as any[])[0];
		assert.equal(childDelta.key?.parentRef, undefined);
	} finally {
		session.kill();
	}
});

test("PiThreadSession completes child thread when subagent finishes", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

	const session = new PiThreadSession(
		{
			threadId: "thr_parent",
			providerThreadId: "pi_durable_root",
			sessionFilePath: "/tmp/fake-dual-end.sqlite",
			sessionDir: "/tmp",
			extensionPath: "/tmp/ext",
			scratchDir: "/tmp/scratch",
		},
		(method, params) => notifications.push({ method, params }),
	);

	try {
		session.registerThread("thr_child", "2");
		session.markSubagentActive("2", { task: "Audit", parentToolCallId: "call_sub_1" });

		const agentEndEvent: RunnerEvent = { messages: [],
			type: "agent_end",
			conversationId: 2,
			parentRef: "call_sub_1",
		};

		await (session as any).handleRunnerEvent(agentEndEvent);

		// Child thread must receive turn.boundary with status completed
		const childNotifs = notifications.filter((n) => n.params.threadId === "thr_child");
		const hasBoundary = childNotifs.some(
			(n) => Array.isArray(n.params.deltas) && (n.params.deltas as any[]).some((d) => d.kind === "turn.boundary"),
		);
		assert.ok(hasBoundary, "Child thread must receive turn.boundary upon agent_end");

		// Parent thread must NOT receive turn.boundary upon child agent_end
		const parentNotifs = notifications.filter((n) => n.params.threadId === "thr_parent");
		const parentHasBoundary = parentNotifs.some(
			(n) => Array.isArray(n.params.deltas) && (n.params.deltas as any[]).some((d) => d.kind === "turn.boundary"),
		);
		assert.equal(parentHasBoundary, false, "Parent thread must not complete turn when child agent_end arrives");

		// Subagent state must transition to completed
		assert.equal(session.getSubagentState("2")?.status, "completed");
	} finally {
		session.kill();
	}
});

test("BBChildEventAdapter decorates all events with conversationId and emits agent_end on run_end", async () => {
	const { BBChildEventAdapter } = await import("../src/runner/bridge/bb-child-event-adapter.ts");
	const wireEvents: any[] = [];
	const adapter = new BBChildEventAdapter((ev) => wireEvents.push(ev), "call_sub_1", 42);

	adapter.handleEvent({
		type: "message_update",
		changes: [{ type: "text_delta", delta: "Working..." }],
	} as any);

	adapter.handleEvent({
		type: "tool_execution_start",
		toolCallId: "call_bash_1",
		toolName: "bash",
		args: { command: "ls" },
	} as any);

	adapter.handleEvent({
		type: "run_end",
	} as any);

	assert.equal(wireEvents.length, 3);
	assert.equal(wireEvents[0].conversationId, 42);
	assert.equal(wireEvents[0].parentRef, "call_sub_1");
	assert.equal(wireEvents[1].conversationId, 42);
	assert.equal(wireEvents[1].parentRef, "call_sub_1");
	assert.equal(wireEvents[2].type, "agent_end");
	assert.equal(wireEvents[2].conversationId, 42);
	assert.equal(wireEvents[2].parentRef, "call_sub_1");
});

test("pure no-runner test: child text/thinking/tools do NOT reach parent, root delegation open/end still does, child receives all", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

	const session = new PiThreadSession(
		{
			threadId: "thr_parent",
			providerThreadId: "pi_durable_root",
			sessionFilePath: "/tmp/fake-pure-isolation.sqlite",
			sessionDir: "/tmp",
			extensionPath: "/tmp/ext",
			scratchDir: "/tmp/scratch",
		},
		(method, params) => notifications.push({ method, params }),
	);

	try {
		session.registerThread("thr_child", "2");
		session.markSubagentActive("2", { task: "Audit", parentToolCallId: "call_sub_1" });

		// 1. Root delegation tool execution start (emitted by parent runner)
		await (session as any).handleRunnerEvent({
			type: "tool_execution_start",
			conversationId: 1,
			toolCallId: "call_sub_1",
			toolName: "subagent",
			args: { task: "Audit" },
		});

		// 2. Child detail events (text, thinking, tool)
		await (session as any).handleRunnerEvent({
			type: "message_update",
			conversationId: 2,
			parentRef: "call_sub_1",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Child thinking or output...",
			},
		});

		await (session as any).handleRunnerEvent({
			type: "tool_execution_start",
			conversationId: 2,
			parentRef: "call_sub_1",
			toolCallId: "call_child_cmd",
			toolName: "bash",
			args: { command: "uptime" },
		});

		// 3. Root delegation tool execution end (emitted by parent runner)
		await (session as any).handleRunnerEvent({
			type: "tool_execution_end",
			conversationId: 1,
			toolCallId: "call_sub_1",
			toolName: "subagent",
			result: { status: "done" },
		});

		// Check parent notifications: must ONLY contain the root delegation tool events!
		const parentNotifs = notifications.filter((n) => n.params.threadId === "thr_parent");
		assert.ok(parentNotifs.length > 0, "Parent must receive root delegation events");
		for (const notif of parentNotifs) {
			const deltas = notif.params.deltas as any[];
			for (const delta of deltas) {
				assert.notEqual(delta.text, "Child thinking or output...", "Parent must not receive child text");
				if (delta.item && (delta.item as any).name) {
					assert.equal((delta.item as any).name, "subagent", "Parent must only see subagent delegation tool");
				}
			}
		}

		// Check child notifications: must receive the child text and tool events without parentRef!
		const childNotifs = notifications.filter((n) => n.params.threadId === "thr_child");
		assert.ok(childNotifs.length >= 2, "Child must receive text and tool deltas");
		const childDeltas = childNotifs.flatMap((n) => n.params.deltas as any[]);
		assert.ok(childDeltas.some((d) => d.text === "Child thinking or output..."), "Child must receive child text");
		assert.ok(
			childDeltas.some((d) => (d.item as any)?.type === "command" || d.key?.providerItemId === "call_child_cmd"),
			"Child must receive child tool",
		);
		for (const d of childDeltas) {
			assert.equal(d.key?.parentRef, undefined, "Child deltas must have parentRef stripped for root display");
		}
	} finally {
		session.kill();
	}
});
