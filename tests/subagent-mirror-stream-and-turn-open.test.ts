import test from "node:test";
import assert from "node:assert/strict";
import { BBChildEventAdapter } from "../src/runner/bridge/bb-child-event-adapter.ts";
import { PiThreadSession } from "../src/host/session.ts";
import { handleTurnStart } from "../src/host/bridge-router.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";
import type { RunnerEvent } from "../src/host/types.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("BBChildEventAdapter: emits turn_start event with conversationId", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBChildEventAdapter((e) => emitted.push(e), "parent_call_1", 42);

	const turnStartEvent = {
		type: "turn_start",
	} as unknown as AgentEvent;

	adapter.handleEvent(turnStartEvent);

	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].type, "turn_start");
	assert.equal(emitted[0].parentRef, "parent_call_1");
	assert.equal(emitted[0].conversationId, 42);
});

test("PiThreadSession: buffers early child runner events and replays on registerThread", async () => {
    const notifications: Array<{
        method: string;
        params: Record<string, unknown>;
    }> = [];
    const session = new PiThreadSession({
        threadId: "thr_parent_buff",
        providerThreadId: "pi_durable_parent_buff",
        sessionFilePath: "/tmp/fake-buff.sqlite",
        sessionDir: "/tmp",
        extensionPath: "/tmp/ext",
        scratchDir: "/tmp/pi-fixture-scratch"
    }, (method, params) => notifications.push({ method, params }));
    try {
        // 1. Runner event arrives BEFORE thread is registered
        const earlyEvent: RunnerEvent = {
            type: "message_update",
            conversationId: "conv_early_99",
            parentRef: "call_early_99",
            assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: "Hello from early subagent!",
            },
        };
        await (session as any).handleRunnerEvent(earlyEvent);
        // No notifications sent to any child thread yet
        const earlyChildDeltas = notifications.filter((n) => n.params.threadId === "thr_child_buffered");
        assert.equal(earlyChildDeltas.length, 0);
        // 2. Now thread is registered (after bb thread spawn completes)
        session.registerThread("thr_child_buffered", "conv_early_99");
        // Notifications must now contain the replayed delta for thr_child_buffered
        const flushedDeltas = notifications.filter((n) => n.params.threadId === "thr_child_buffered");
        assert.ok(flushedDeltas.length > 0, "Buffered events must be flushed to child thread");
        const deltas = flushedDeltas[0].params.deltas as any[];
        assert.ok(deltas.some((d) => d.kind === "item.textDelta" && d.text === "Hello from early subagent!"));
    }
    finally {
        session.kill();
    }
});

test("handleTurnStart: running mirror emits turn.open to prevent 120s timeout", async () => {
    const notifications: Array<{
        method: string;
        params: Record<string, unknown>;
    }> = [];
    const results: Array<{
        id: string | number;
        result: Record<string, unknown>;
    }> = [];
    const mockSession = sessionFixture({
        runner: { exited: false },
        options: { threadId: "thr_parent" },
        findSubagentConversationForTask: () => "conv_running_1",
        getSubagentState: (id: string) => (id === "conv_running_1" ? { status: "running", task: "Audit" } : undefined),
        markInitialMirrorTurnConsumed: () => { },
        registerThread: () => false,
    });
    const registry = new SessionRegistry(() => { });
    registry.track("thr_parent", mockSession);
    const ctx = {
        registry,
        sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
        sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
        sendError: () => { },
    };
    await handleTurnStart("req_run_1", {
        threadId: "thr_child_run",
        parentThreadId: "thr_parent",
        input: [{ type: "text", text: "Audit" }],
        clientRequestId: "creq_23456789ab",
    }, ctx);
    // Results acknowledged
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "req_run_1");
    // Notifications must include input.accepted AND turn.open!
    const childDeltas = notifications
        .filter((n) => n.method === "thread/delta" && n.params.threadId === "thr_child_run")
        .flatMap((n) => n.params.deltas as any[]);
    assert.ok(childDeltas.some((d) => d.kind === "input.accepted"), "Must emit input.accepted");
    assert.ok(childDeltas.some((d) => d.kind === "turn.open"), "Must emit turn.open to satisfy watchdog");
});

test("handleTurnStart: completed mirror emits turn.open, accumulated text, and turn.boundary", async () => {
    const notifications: Array<{
        method: string;
        params: Record<string, unknown>;
    }> = [];
    const results: Array<{
        id: string | number;
        result: Record<string, unknown>;
    }> = [];
    const mockSession = sessionFixture({
        runner: { exited: false },
        options: { threadId: "thr_parent" },
        findSubagentConversationForTask: () => "conv_done_1",
        getSubagentState: (id: string) => (id === "conv_done_1" ? { status: "completed", task: "Quick Task", result: "Task complete result!" } : undefined),
        getMirrorOutputText: () => "Task complete result!",
        consumeCompletedMirror: () => { },
        markInitialMirrorTurnConsumed: () => { },
        registerThread: () => false,
    });
    const registry = new SessionRegistry(() => { });
    registry.track("thr_parent", mockSession);
    const ctx = {
        registry,
        sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
        sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
        sendError: () => { },
    };
    await handleTurnStart("req_done_1", {
        threadId: "thr_child_done",
        parentThreadId: "thr_parent",
        input: [{ type: "text", text: "Quick Task" }],
        clientRequestId: "creq_23456789ab",
    }, ctx);
    // Results acknowledged
    assert.equal(results.length, 1);
    // Notifications must include input.accepted, turn.open, text, and turn.boundary completed!
    const childDeltas = notifications
        .filter((n) => n.method === "thread/delta" && n.params.threadId === "thr_child_done")
        .flatMap((n) => n.params.deltas as any[]);
    assert.ok(childDeltas.some((d) => d.kind === "input.accepted"), "Must emit input.accepted");
    assert.ok(childDeltas.some((d) => d.kind === "turn.open"), "Must emit turn.open");
    assert.ok(childDeltas.some((d) => d.kind === "item.textClose" && d.text === "Task complete result!"), "Must emit assistant message");
    assert.ok(childDeltas.some((d) => d.kind === "turn.boundary" && d.status === "completed"), "Must emit completed boundary");
});
