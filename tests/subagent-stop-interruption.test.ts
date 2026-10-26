import type { PromptRequest } from "../src/host/prompt-request.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import {
	handleThreadStop,
	handleTurnSteer,
	type BridgeRouterContext,
	type ThreadStopParams,
	type TurnSteerParams,
} from "../src/host/bridge-router.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { PiThreadSession } from "../src/host/session.ts";
import type { RunnerEvent } from "../src/host/types.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("Slice 6.1: handleThreadStop on child thread targets child conversation and isolates parent", async () => {
    const notifications: Array<{
        method: string;
        params: Record<string, unknown>;
    }> = [];
    const results: Array<{
        id: string | number;
        result: Record<string, unknown>;
    }> = [];
    const errors: Array<{
        id: string | number;
        code: number;
        message: string;
    }> = [];
    let abortArg: string | undefined = "INITIAL_UNSET";
    const mockSession = sessionFixture({
        options: { threadId: "thr_parent", providerThreadId: "pi_durable_root:1" },
        runner: { exited: false },
        abort: async (convId?: string) => {
            abortArg = convId;
        },
        getLastCheckpointId: () => "chk_child_99",
        getConversationIdForThread: (threadId: string) => {
            if (threadId === "thr_child_1")
                return "conv_child_42";
            return undefined;
        },
    });
    const registry = new SessionRegistry(() => { });
    registry.track("thr_parent", mockSession);
    registry.track("thr_child_1", mockSession);
    const ctx: BridgeRouterContext = {
        registry,
        sendNotification: (method, params) => notifications.push({ method, params }),
        sendResult: (id, result) => results.push({ id, result }),
        sendError: (id, code, message) => errors.push({ id, code, message }),
    };
    const params: ThreadStopParams = {
        threadId: "thr_child_1",
        intent: "interrupt",
        activeTurnId: "turn_child_1",
    };
    await handleThreadStop("req_stop_child", params, ctx);
    // 1. session.abort was called with the child conversationId, NOT undefined / parent
    assert.equal(abortArg, "conv_child_42", "session.abort must be called with child conversationId");
    // 2. session.ended delta was emitted ONLY to the child thread
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].method, "thread/delta");
    assert.equal(notifications[0].params.threadId, "thr_child_1");
    const deltas = notifications[0].params.deltas as Array<{
        kind: string;
    }>;
    assert.deepEqual(deltas, [{ kind: "session.ended" }]);
    assert.equal(threadDeltaSchema.safeParse(deltas[0]).success, true);
    // 3. Response contains ok: true and providerCheckpointId
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "req_stop_child");
    assert.deepEqual(results[0].result, {
        ok: true,
        providerCheckpointId: "chk_child_99",
    });
    // 4. Neither thread was stopped/purged from registry
    assert.equal(registry.get("thr_parent"), mockSession);
    assert.equal(registry.get("thr_child_1"), mockSession);
});

test("Slice 6.1: handleTurnSteer on child thread resolves child conversation without explicit providerThreadId", async () => {
    const notifications: Array<{
        method: string;
        params: Record<string, unknown>;
    }> = [];
    const results: Array<{
        id: string | number;
        result: Record<string, unknown>;
    }> = [];
    const errors: Array<{
        id: string | number;
        code: number;
        message: string;
    }> = [];
    let steerArgs: {
        text: string;
        conversationId?: string;
    } | undefined;
    const mockSession = sessionFixture({
        options: { threadId: "thr_parent", providerThreadId: "pi_durable_root:1" },
        steer: async ({ text, conversationId }: PromptRequest) => {
            steerArgs = { text, conversationId };
        },
        getConversationIdForThread: (threadId: string) => {
            if (threadId === "thr_child_1")
                return "conv_child_42";
            return undefined;
        },
    });
    const registry = new SessionRegistry(() => { });
    registry.track("thr_child_1", mockSession);
    const ctx: BridgeRouterContext = {
        registry,
        sendNotification: (method, params) => notifications.push({ method, params }),
        sendResult: (id, result) => results.push({ id, result }),
        sendError: (id, code, message) => errors.push({ id, code, message }),
    };
    const params: TurnSteerParams = {
        threadId: "thr_child_1",
        input: [{ type: "text", text: "focus only on tests" }],
        clientRequestId: "creq_23456789ab",
    };
    await handleTurnSteer("req_steer_child", params, ctx);
    // 1. steer was called with child conversationId
    assert.deepEqual(steerArgs, {
        text: "focus only on tests",
        conversationId: "conv_child_42",
    });
    // 2. input.accepted was emitted to the child thread
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].params.threadId, "thr_child_1");
    const deltas = notifications[0].params.deltas as Array<{
        kind: string;
        clientRequestId?: string;
    }>;
    assert.deepEqual(deltas, [{ kind: "input.accepted", clientRequestId: "creq_23456789ab" }]);
});

test("Slice 6.1: aborted subagent agent_end emits turn.boundary with status interrupted to child thread", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

	const session = new PiThreadSession(
		{
			threadId: "thr_parent",
			providerThreadId: "pi_durable_root",
			sessionFilePath: "/tmp/fake-abort-end.sqlite",
			sessionDir: "/tmp",
			extensionPath: "/tmp/ext",
			scratchDir: "/tmp/scratch",
		},
		(method, params) => notifications.push({ method, params }),
	);

	try {
		session.registerThread("thr_child_1", "conv_child_42");
		session.markSubagentActive("conv_child_42", { task: "Deep Analysis", parentToolCallId: "call_sub_1" });

		const abortedAgentEnd: RunnerEvent = { messages: [],
			type: "agent_end",
			conversationId: "conv_child_42",
			parentRef: "call_sub_1",
			aborted: true,
			stopReason: "aborted",
		};

		await (session as any).handleRunnerEvent(abortedAgentEnd);

		// Child thread must receive turn.boundary with status 'interrupted'
		const childNotifs = notifications.filter((n) => n.params.threadId === "thr_child_1");
		const boundaryNotif = childNotifs.find(
			(n) => Array.isArray(n.params.deltas) && (n.params.deltas as any[]).some((d) => d.kind === "turn.boundary"),
		);
		assert.ok(boundaryNotif, "Child thread must receive turn.boundary upon aborted agent_end");
		const boundaryDelta = (boundaryNotif.params.deltas as any[]).find((d) => d.kind === "turn.boundary");
		assert.equal(boundaryDelta.status, "interrupted", "turn.boundary status must be 'interrupted'");

		// Parent thread must NOT receive turn.boundary
		const parentNotifs = notifications.filter((n) => n.params.threadId === "thr_parent");
		const parentHasBoundary = parentNotifs.some(
			(n) => Array.isArray(n.params.deltas) && (n.params.deltas as any[]).some((d) => d.kind === "turn.boundary"),
		);
		assert.equal(parentHasBoundary, false, "Parent thread must not receive turn.boundary on child abort");

		// Subagent state must transition to completed
		assert.equal(session.getSubagentState("conv_child_42")?.status, "completed");
	} finally {
		session.kill();
	}
});
