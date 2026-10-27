import test from "node:test";
import assert from "node:assert/strict";
import { handleTurnStart, type TurnStartParams } from "../src/host/bridge-router.ts";
import { decideMirrorAdoption } from "../src/host/mirror-adoption.ts";
import type { OwnedSessionPort } from "../src/host/session-port.ts";

test("decideMirrorAdoption: already consumed turn bypasses adoption", () => {
	const runningState = { task: "inspect repo", status: "running" as const };

	// 1. Unconsumed initial turn matches
	assert.equal(decideMirrorAdoption(runningState, "inspect repo"), "running");

	// 2. Already consumed turn must be ordinary
	assert.equal(decideMirrorAdoption({ ...runningState, initialTurnConsumed: true }, "inspect repo"), "ordinary");
});

test("handleTurnStart: resume on bound child dispatches prompt, never swallows as running adoption", async () => {
	let promptCalled = false;
	let promptedText = "";
	const threadDeltas: any[] = [];
	const notifications: any[] = [];

	const mockSession: OwnedSessionPort = {
		options: {
			threadId: "thr_child_resumed",
			providerThreadId: "pi_durable_test:21848",
			parentThreadId: "thr_parent_main",
		},
		runner: { exited: false, requestOk: async () => ({}) },
		async start() {},
		async closeGracefully() {},
		kill() {},
		unregisterThread() {},
		async prompt(req) {
			promptCalled = true;
			promptedText = req.text;
		},
		async steer() {},
		async abort() {},
		async compact() {},
		async refreshContextUsage() {},
		getLastCheckpointId: () => null,
		registerThread: () => true,
		// Thread is already registered to conversation 21848
		getConversationIdForThread: (tid: string) => (tid === "thr_child_resumed" ? "21848" : undefined),
		getThreadIdForConversation: (cid: string | number) => (String(cid) === "21848" ? "thr_child_resumed" : undefined),
		getSubagentState: () => ({
			task: "continue task",
			status: "running", // stale running flag from prior attempt
			initialTurnConsumed: true,
		}),
		findSubagentConversationForTask: () => "21848",
		getMirrorOutputText: () => "",
		markInitialMirrorTurnConsumed() {},
		consumeCompletedMirror() {},
		async setModel() {},
		async setThinkingLevel() {},
		async setSubagentPolicy() {},
		getAcknowledgedSubagentPolicyRevision: () => undefined,
	};

	const ctx = {
		registry: {
			get: () => mockSession,
			createOrGet: async () => mockSession,
			reconcileCwd: async () => mockSession,
			stop: async () => {},
		},
		sendNotification: (method: string, params: any) => {
			notifications.push({ method, params });
			if (method === "thread/delta") threadDeltas.push(...params.deltas);
		},
		sendResult: () => {},
		sendError: (_id: any, code: number, msg: string) => {
			throw new Error(`RPC Error ${code}: ${msg}`);
		},
	};

	const params: TurnStartParams = {
		threadId: "thr_child_resumed",
		providerThreadId: "pi_durable_test:21848",
		input: [{ type: "text", text: "continue task" }],
	};

	await handleTurnStart("req_1", params, ctx);

	assert.equal(promptCalled, true, "session.prompt must be called for resumed/subsequent child turn");
	assert.equal(promptedText, "continue task");
	assert.ok(threadDeltas.some((d) => d.kind === "turn.open"), "Must emit turn.open");
});
