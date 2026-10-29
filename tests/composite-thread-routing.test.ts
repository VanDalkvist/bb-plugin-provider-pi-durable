import type { PromptRequest } from "../src/host/prompt-request.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderThreadId, formatProviderThreadId } from "../src/host/composite-id.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import type { PiThreadSession } from "../src/host/session.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("parseProviderThreadId correctly distinguishes root session and composite child conversations", () => {
	const root = parseProviderThreadId("pi_durable_1740000000");
	assert.equal(root.sessionKey, "pi_durable_1740000000");
	assert.equal(root.conversationId, undefined);

	const child = parseProviderThreadId("pi_durable_1740000000:conv_sub123");
	assert.equal(child.sessionKey, "pi_durable_1740000000");
	assert.equal(child.conversationId, "conv_sub123");

	const emptyChild = parseProviderThreadId("pi_durable_1740000000:");
	assert.equal(emptyChild.sessionKey, "pi_durable_1740000000");
	assert.equal(emptyChild.conversationId, undefined);

	assert.equal(formatProviderThreadId("sess1", "conv2"), "sess1:conv2");
	assert.equal(formatProviderThreadId("sess1"), "sess1");
});

test("SessionRegistry shares active session across composite child threadIds", async () => {
    const notifications: Array<{
        method: string;
        params: Record<string, unknown>;
    }> = [];
    let closeCalled = false;
    const registeredThreads: Array<{
        threadId: string;
        conversationId?: string;
    }> = [];
    const unregisteredThreads: string[] = [];
    const mockSession = sessionFixture({
        runner: { exited: false },
        options: {
            threadId: "thr_parent",
            providerThreadId: "pi_durable_root123",
        },
        registerThread: (threadId: string, conversationId?: string) => {
            registeredThreads.push({ threadId, conversationId });
            return false;
        },
        unregisterThread: (threadId: string) => {
            unregisteredThreads.push(threadId);
        },
        getSubagentState: () => ({ status: "running", task: "Subagent task" }),
        closeGracefully: async () => {
            closeCalled = true;
        },
    });
    const registry = new SessionRegistry((method, params) => {
        notifications.push({ method, params });
    });
    // Register parent session
    registry.track("thr_parent", mockSession);
    // Child thread connects with composite providerThreadId
    const childSession = await registry.createOrGet("thr_child", "pi_durable_root123:conv_child99", {
        cwd: "/test",
    });
    // Should reuse the exact same session instance
    assert.equal(childSession, mockSession);
    assert.equal(registry.get("thr_child"), mockSession);
    assert.deepEqual(registeredThreads, [{ threadId: "thr_child", conversationId: "conv_child99" }]);
    // Should have emitted identity and delta reset for child thread
    assert.equal(notifications.length, 2);
    assert.equal(notifications[0].method, "thread/identity");
    assert.equal(notifications[0].params.threadId, "thr_child");
    assert.equal(notifications[0].params.providerThreadId, "pi_durable_root123:conv_child99");
    // Stopping child thread should NOT close parent session
    await registry.stop("thr_child");
    assert.deepEqual(unregisteredThreads, ["thr_child"]);
    assert.equal(registry.get("thr_child"), undefined);
    assert.equal(registry.get("thr_parent"), mockSession);
    assert.equal(closeCalled, false, "Parent session must remain alive when child thread stops");
    // Stopping parent thread should now close the session
    await registry.stop("thr_parent");
    assert.equal(closeCalled, true, "Session must close when last referencing thread stops");
});

test("bridge-router propagates conversationId to session prompt, steer, and abort", async () => {
    let promptArgs: {
        text: string;
        conversationId?: string;
    } | undefined;
    let steerArgs: {
        text: string;
        conversationId?: string;
    } | undefined;
    let abortArgs: {
        conversationId?: string;
    } | undefined;
    const mockSession = sessionFixture({
        runner: { exited: false },
        options: {
            threadId: "thr_child",
            providerThreadId: "pi_durable_root:conv_child99",
        },
        prompt: async ({ text, conversationId }: PromptRequest) => {
            promptArgs = { text, conversationId };
        },
        steer: async ({ text, conversationId }: PromptRequest) => {
            steerArgs = { text, conversationId };
        },
        abort: async (conversationId?: string) => {
            abortArgs = { conversationId };
        },
        getLastCheckpointId: () => "chk_child_1",
    });
    const registry = new SessionRegistry(() => { });
    registry.track("thr_child", mockSession);
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
    const ctx = {
        registry,
        sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
        sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
        sendError: (id: string | number, code: number, message: string) => errors.push({ id, code, message }),
    };
    // Test TurnStart
    const { handleTurnStart, handleTurnSteer, handleThreadStop } = await import("../src/host/bridge-router.ts");
    await handleTurnStart("req_1", {
        threadId: "thr_child",
        providerThreadId: "pi_durable_root:conv_child99",
        input: [{ type: "text", text: "child task input" }],
    }, ctx);
    assert.deepEqual(promptArgs, { text: "child task input", conversationId: "conv_child99" });
    // Test TurnSteer
    await handleTurnSteer("req_2", {
        threadId: "thr_child",
        providerThreadId: "pi_durable_root:conv_child99",
        input: [{ type: "text", text: "child steer input" }],
    }, ctx);
    assert.deepEqual(steerArgs, { text: "child steer input", conversationId: "conv_child99" });
    // Test ThreadStop interrupt
    await handleThreadStop("req_3", {
        threadId: "thr_child",
        providerThreadId: "pi_durable_root:conv_child99",
        intent: "interrupt",
    }, ctx);
    assert.deepEqual(abortArgs, { conversationId: "conv_child99" });
});
