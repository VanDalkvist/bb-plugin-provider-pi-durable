import test from "node:test";
import assert from "node:assert/strict";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import {
	validateChildTurn,
	isChildTurn,
	resolveTargetConversationId,
} from "../src/host/child-turn-guard.ts";
import { detectNativeChild } from "../src/host/session-owner.ts";

test("validateChildTurn: parses flat runner DTO and blocks model override on cold mirror (P1 repro)", async () => {
	const session = {
		options: { threadId: "root_1" },
		getSubagentState: () => ({ status: "running" as const, task: "child task" }), // cold mirror, actualModel undefined
		runner: {
			requestOk: async (cmd: Record<string, unknown>) => {
				assert.equal(cmd.type, "get_state");
				assert.equal(cmd.conversationId, "conv_42");
				return {
					model: { provider: "antigravity", id: "gemini-3.8-flash", modelId: "gemini-3.8-flash" },
					thinkingLevel: "low",
				};
			},
		},
	};

	// 1. Different model must be rejected with -32602
	const res = await validateChildTurn(
		{ threadId: "child_1", options: { model: "anthropic/claude-3-7-sonnet" } },
		session as any,
		"conv_42",
	);
	assert.equal(res.valid, false, "Model override must be rejected");
	if (!res.valid) {
		assert.equal(res.code, -32602);
		assert.ok(res.message.includes("CHILD_MODEL_POLICY_LOCKED"));
	}

	// 2. Matching model must be accepted
	const matchRes = await validateChildTurn(
		{ threadId: "child_1", options: { model: "antigravity/gemini-3.8-flash", reasoningLevel: "low" } },
		session as any,
		"conv_42",
	);
	assert.equal(matchRes.valid, true, "Matching model and thinking must be allowed");
});

test("validateChildTurn: fails closed when runner state fetch fails or model is unresolvable", async () => {
	const failingSession = {
		options: { threadId: "root_1" },
		getSubagentState: () => ({ status: "running" as const, task: "task" }),
		runner: {
			requestOk: async () => {
				throw new Error("Runner communication failure");
			},
		},
	};

	// When an override is requested but state cannot be resolved, fail-closed
	const res = await validateChildTurn(
		{ threadId: "child_1", options: { model: "anthropic/claude-3-7-sonnet" } },
		failingSession as any,
		"conv_99",
	);
	assert.equal(res.valid, false, "Must fail closed if child model cannot be resolved");
	if (!res.valid) {
		assert.equal(res.code, -32602);
		assert.ok(res.message.includes("CHILD_MODEL_POLICY_LOCKED"));
	}
});

test("validateChildTurn: checks thinking level when model is cached but thinking is missing", async () => {
	const session = {
		options: { threadId: "root_1" },
		getSubagentState: () => ({
			status: "running" as const,
			task: "task",
			actualModel: { provider: "p1", modelId: "m1" },
			// thinkingLevel is undefined in cache
		}),
		runner: {
			requestOk: async () => ({
				model: { provider: "p1", id: "m1", modelId: "m1" },
				thinkingLevel: "low",
			}),
		},
	};

	const res = await validateChildTurn(
		{ threadId: "child_1", options: { reasoningLevel: "high" } },
		session as any,
		"conv_1",
	);
	assert.equal(res.valid, false, "Thinking override must be rejected even if model was cached");
});

test("isChildTurn: manual BB subthread with parentThreadId is NOT a child if it has its own root session", () => {
	const manualSession = {
		options: {
			threadId: "manual_subthread_1",
			providerThreadId: "pi_durable_independent_123",
		},
	};

	const params = {
		threadId: "manual_subthread_1",
		providerThreadId: "pi_durable_independent_123",
		parentThreadId: "parent_root_1",
	};

	assert.equal(
		isChildTurn(params, manualSession as any),
		false,
		"Independent root session must not be classified as child merely due to parentThreadId",
	);
});

test("isChildTurn and detectNativeChild: explicit ROOT_CONVERSATION_ID in composite ID is not a child", () => {
	const rootConvIdStr = String(ROOT_CONVERSATION_ID);
	const params = {
		threadId: "root_thread",
		providerThreadId: `session_key_1:${ROOT_CONVERSATION_ID}`,
	};
	assert.equal(isChildTurn(params), false, `Conversation ${ROOT_CONVERSATION_ID} is root, not a child`);
	assert.equal(resolveTargetConversationId(params, { options: { threadId: "root_thread" } }), undefined);

	// detectNativeChild must NOT treat ROOT_CONVERSATION_ID as native child
	const rootResolution = detectNativeChild("root_thread", rootConvIdStr, undefined, undefined);
	assert.equal(rootResolution.isNative, false, "Root conversation ID must not be classified as native child");

	// Real child (e.g. conversation "2" or "conv_42") MUST be classified as child
	const childParams = {
		threadId: "child_thread",
		providerThreadId: `session_key_1:2`,
	};
	assert.equal(isChildTurn(childParams), true, "Conversation 2 is a child");
	assert.equal(resolveTargetConversationId(childParams, { options: { threadId: "root_thread" } }), "2");

	const childResolution = detectNativeChild("child_thread", "2", undefined, undefined);
	assert.equal(childResolution.isNative, true);
	assert.equal(childResolution.conversationId, "2");
});
