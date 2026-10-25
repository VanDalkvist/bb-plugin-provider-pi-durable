import type { PromptRequest } from "../src/host/prompt-request.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleTurnStart, handleTurnSteer, type BridgeRouterContext } from "../src/host/bridge-router.ts";
import { buildSpawnArgs } from "../src/host/subthread-spawner.ts";
import { detectNativeChild } from "../src/host/session-owner.ts";

describe("Subagent Mirror Guard & Root Isolation (Task 6)", () => {
	it("child mirror turn does not mutate root session model, thinking, CWD, or policy", async () => {
		let rootModelChanged = false;
		let rootThinkingChanged = false;
		let promptCalledWith: { text: string; conversationId?: string } | undefined;

		const mockSession: any = {
			options: {
				threadId: "root_thread_1",
				providerThreadId: "pi_durable_sessionKey",
				cwd: "/workspace/root",
				model: { provider: "anthropic", id: "claude-3-7-sonnet" },
				thinkingLevel: "low",
				providerOptions: { subagentPolicy: { revision: 1, mode: "inherit" } },
			},
			setModel: async () => { rootModelChanged = true; },
			setThinkingLevel: async () => { rootThinkingChanged = true; },
			setSubagentPolicy: async () => { throw new Error("Child should not update policy"); },
			getAcknowledgedSubagentPolicyRevision: () => 1,
			getConversationIdForThread: (tid: string) => (tid === "child_thread_1" ? "conv_42" : undefined),
			getSubagentState: () => ({
				status: "running",
				task: "child initial task",
				actualModel: { provider: "antigravity", modelId: "gemini-3.8-flash" },
				thinkingLevel: "high",
				initialTurnConsumed: true,
			}),
			prompt: async ({ text, conversationId }: PromptRequest) => {
				promptCalledWith = { text, conversationId };
			},
		};

		const mockCtx: BridgeRouterContext = {
			registry: {
				get: (tid: string) => (tid === "child_thread_1" || tid === "root_thread_1" ? mockSession : undefined),
				reconcileCwd: async () => { throw new Error("reconcileCwd must not be called on child turn"); },
				createOrGet: async () => mockSession,
			} as any,
			sendNotification: () => {},
			sendResult: () => {},
			sendError: (_id, _code, msg) => { throw new Error(`sendError: ${msg}`); },
		};

		await handleTurnStart(
			1,
			{
				threadId: "child_thread_1",
				providerThreadId: "pi_durable_sessionKey:conv_42",
				cwd: "/different/child/cwd",
				options: {
					cwd: "/different/child/cwd",
					model: "antigravity/gemini-3.8-flash",
					reasoningLevel: "high",
				},
				input: [{ type: "text", text: "child followup prompt" }],
			},
			mockCtx,
		);

		assert.equal(rootModelChanged, false, "root model must not be changed by child turn");
		assert.equal(rootThinkingChanged, false, "root thinking must not be changed by child turn");
		assert.deepEqual(promptCalledWith, { text: "child followup prompt", conversationId: "conv_42" });
	});

	it("compaction command on child thread is explicitly rejected", async () => {
		let errorCode: number | undefined;
		let errorMessage: string | undefined;

		const mockSession: any = {
			options: { threadId: "root_thread_1" },
			getConversationIdForThread: () => "conv_42",
		};

		const mockCtx: BridgeRouterContext = {
			registry: {
				get: () => mockSession,
				reconcileCwd: async () => mockSession,
				createOrGet: async () => mockSession,
			} as any,
			sendNotification: () => {},
			sendResult: () => {},
			sendError: (_id, code, msg) => {
				errorCode = code;
				errorMessage = msg;
			},
		};

		await handleTurnStart(
			1,
			{
				threadId: "child_thread_1",
				input: [{ type: "text", text: "/compact summarize context" }],
			},
			mockCtx,
		);

		assert.equal(errorCode, -32602);
		assert.match(errorMessage ?? "", /compact/i);
	});

	it("child model override is rejected with -32602 CHILD_MODEL_POLICY_LOCKED", async () => {
		let errorCode: number | undefined;
		let errorMessage: string | undefined;

		const mockSession: any = {
			options: { threadId: "root_thread_1" },
			getConversationIdForThread: () => "conv_42",
			getSubagentState: () => ({
				status: "running",
				task: "task",
				actualModel: { provider: "antigravity", modelId: "gemini-3.8-flash" },
				thinkingLevel: "high",
				initialTurnConsumed: true,
			}),
		};

		const mockCtx: BridgeRouterContext = {
			registry: {
				get: () => mockSession,
				reconcileCwd: async () => mockSession,
				createOrGet: async () => mockSession,
			} as any,
			sendNotification: () => {},
			sendResult: () => {},
			sendError: (_id, code, msg) => {
				errorCode = code;
				errorMessage = msg;
			},
		};

		await handleTurnStart(
			1,
			{
				threadId: "child_thread_1",
				options: { model: "anthropic/claude-3-7-sonnet" },
				input: [{ type: "text", text: "followup" }],
			},
			mockCtx,
		);

		assert.equal(errorCode, -32602);
		assert.match(errorMessage ?? "", /CHILD_MODEL_POLICY_LOCKED/);
	});

	it("child thinking override is rejected with -32602, while none/off equivalent is allowed", async () => {
		let errorCode: number | undefined;
		let errorMessage: string | undefined;

		const mockSession: any = {
			options: { threadId: "root_thread_1" },
			getConversationIdForThread: () => "conv_42",
			getSubagentState: () => ({
				status: "running",
				task: "task",
				actualModel: { provider: "openai", modelId: "gpt-4o" },
				thinkingLevel: "off",
				initialTurnConsumed: true,
			}),
			prompt: async () => {},
		};

		const mockCtx: BridgeRouterContext = {
			registry: {
				get: () => mockSession,
				reconcileCwd: async () => mockSession,
				createOrGet: async () => mockSession,
			} as any,
			sendNotification: () => {},
			sendResult: () => {},
			sendError: (_id, code, msg) => {
				errorCode = code;
				errorMessage = msg;
			},
		};

		// 1. none matches off -> allowed
		await handleTurnStart(
			1,
			{
				threadId: "child_thread_1",
				options: { reasoningLevel: "none" },
				input: [{ type: "text", text: "followup ok" }],
			},
			mockCtx,
		);
		assert.equal(errorCode, undefined);

		// 2. high differs from off -> rejected
		await handleTurnStart(
			2,
			{
				threadId: "child_thread_1",
				options: { reasoningLevel: "high" },
				input: [{ type: "text", text: "followup rejected" }],
			},
			mockCtx,
		);
		assert.equal(errorCode, -32602);
		assert.match(errorMessage ?? "", /CHILD_MODEL_POLICY_LOCKED/);
	});

	it("subthread-spawner passes actual model and normalized reasoning level in CLI args", () => {
		const args = buildSpawnArgs({
			parentThreadId: "parent_1",
			title: "Subagent Task",
			task: "Execute test task",
			actualModel: { provider: "antigravity", modelId: "gemini-3.8-flash" },
			thinkingLevel: "off",
		} as any);

		assert.ok(args.includes("--model"));
		assert.equal(args[args.indexOf("--model") + 1], "antigravity/gemini-3.8-flash");
		assert.ok(args.includes("--reasoning-level"));
		assert.equal(args[args.indexOf("--reasoning-level") + 1], "none");
	});

	it("detectNativeChild identifies native composite conversation vs non-native child", () => {
		// 1. Native composite ID
		const native1 = detectNativeChild("child_1", "conv_99", undefined, undefined);
		assert.equal(native1.isNative, true);
		assert.equal(native1.conversationId, "conv_99");

		// 2. Native params.conversationId
		const native2 = detectNativeChild("child_2", undefined, "conv_100", undefined);
		assert.equal(native2.isNative, true);
		assert.equal(native2.conversationId, "conv_100");

		// 3. Non-native child: has parent, but no native binding
		const nonNative = detectNativeChild("manual_cli_child", undefined, undefined, "/nonexistent/session.sqlite");
		assert.equal(nonNative.isNative, false);
		assert.equal(nonNative.conversationId, undefined);
	});
});
