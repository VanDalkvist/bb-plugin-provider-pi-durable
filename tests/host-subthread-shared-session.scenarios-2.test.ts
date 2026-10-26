import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { handleTurnStart } from "../src/host/bridge-router.ts";
import { PiThreadSession } from "../src/host/session.ts";
import type { RunnerEvent } from "../src/host/types.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("handleTurnStart intercepts running subagent turn on child thread and suppresses duplicate prompt", async () => {
    let promptCalls = 0;
    const registeredThreads: Array<{
        threadId: string;
        conversationId?: string;
    }> = [];
    const notifications: Array<{
        method: string;
        params: Record<string, unknown>;
    }> = [];
    const results: Array<{
        id: string | number;
        result: Record<string, unknown>;
    }> = [];
    const mockParentSession = sessionFixture({
        runner: { exited: false },
        options: { threadId: "thr_parent", providerThreadId: "pi_durable_root" },
        prompt: async () => {
            promptCalls++;
        },
        findSubagentConversationForTask: (task: string) => (task === "Run background test" ? "conv_sub_bg" : undefined),
        getSubagentState: (convId: string) => (convId === "conv_sub_bg" ? { status: "running", task: "Run background test" } : undefined),
        markInitialMirrorTurnConsumed: () => { },
        registerThread: (threadId: string, conversationId?: string) => {
            registeredThreads.push({ threadId, conversationId });
            return false;
        },
    });
    const registry = new SessionRegistry(() => { });
    registry.track("thr_parent", mockParentSession);
    const ctx = {
        registry,
        sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
        sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
        sendError: () => { },
    };
    await handleTurnStart("req_spawn_child_1", {
        threadId: "thr_child_spawn",
        providerThreadId: "pi_durable_child_random_500",
        parentThreadId: "thr_parent",
        input: [{ type: "text", text: "Run background test" }],
        clientRequestId: "creq_23456789ab",
    }, ctx);
    // 1. Duplicate prompt was NOT called
    assert.equal(promptCalls, 0, "session.prompt must not be called for an actively running subagent");
    // 2. Thread was registered with the parent session under the subagent conversationId
    assert.ok(registeredThreads.some((r) => r.threadId === "thr_child_spawn" && r.conversationId === "conv_sub_bg"), "Child thread must be registered with conversationId");
    // 3. Turn was acknowledged to BB
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "req_spawn_child_1");
    // 4. input.accepted was emitted for the child thread
    const acceptedDelta = notifications.find((n) => n.method === "thread/delta" && n.params.threadId === "thr_child_spawn");
    assert.ok(acceptedDelta, "input.accepted must be emitted for child thread");
});

test("Subagent runner events for registered child thread stream cleanly", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

	const session = new PiThreadSession(
		{
			threadId: "thr_parent",
			providerThreadId: "pi_durable_root",
			sessionFilePath: "/tmp/fake-child-stream.sqlite",
			sessionDir: "/tmp",
			extensionPath: "/tmp/ext",
			scratchDir: "/tmp/scratch",
		},
		(method, params) => notifications.push({ method, params }),
	);

	try {
		session.registerThread("thr_child_stream", "conv_stream_77");
		session.markSubagentActive("conv_stream_77", { task: "Streaming audit", parentToolCallId: "call_sub_77" });

		const childEvent: RunnerEvent = {
			type: "message_update",
			conversationId: "conv_stream_77",
			parentRef: "call_sub_77",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Analyzing AST...",
			},
		};

		await (session as any).handleRunnerEvent(childEvent);

		// Child thread must receive delta without parentRef
		const childNotifs = notifications.filter((n) => n.params.threadId === "thr_child_stream");
		assert.ok(childNotifs.length > 0, "Child thread must receive root streaming deltas");
		const childDelta = (childNotifs[0].params.deltas as any[])[0];
		assert.equal(childDelta.key?.parentRef, undefined);

		// Now simulate agent_end
		const agentEndEvent: RunnerEvent = { messages: [],
			type: "agent_end",
			conversationId: "conv_stream_77",
			parentRef: "call_sub_77",
		};

		await (session as any).handleRunnerEvent(agentEndEvent);

		// Child thread must receive turn.boundary completed
		const childBoundaries = notifications.filter(
			(n) =>
				n.params.threadId === "thr_child_stream" &&
				Array.isArray(n.params.deltas) &&
				(n.params.deltas as any[]).some((d) => d.kind === "turn.boundary" && d.status === "completed"),
		);
		assert.ok(childBoundaries.length > 0, "Child thread must receive completed turn.boundary upon agent_end");
	} finally {
		session.kill();
	}
});
