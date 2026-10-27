import test from "node:test";
import assert from "node:assert/strict";
import {
	runtimeTaskNodeSchema,
	runtimeTaskReceiptSchema,
	runtimeGraphSnapshotSchema,
} from "../src/runtime-graph/schema.ts";

test("runtime-graph-live-metadata contract: accepts sanitized metadata on live task node", () => {
	const node = {
		id: 42,
		kind: "pi.tool",
		conversationId: 1,
		background: false,
		abortRequested: false,
		state: { status: "running", phase: "execute" },
		label: "read: src/runner/index.ts",
		startedAt: 1793110000000,
		durationMs: 45,
		toolName: "read",
		targetHint: "src/runner/index.ts",
	};

	const res = runtimeTaskNodeSchema.safeParse(node);
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.toolName, "read");
		assert.equal(res.data.targetHint, "src/runner/index.ts");
	}
});

test("runtime-graph-live-metadata contract: accepts model and thinkingLevel on generation node", () => {
	const node = {
		id: 43,
		kind: "pi.generation",
		conversationId: 1,
		background: false,
		abortRequested: false,
		state: { status: "running", phase: "request" },
		label: "gemini-3.8-flash (high)",
		startedAt: 1793110000000,
		durationMs: 12000,
		model: { provider: "antigravity", modelId: "gemini-3.8-flash" },
		thinkingLevel: "high",
	};

	const res = runtimeTaskNodeSchema.safeParse(node);
	assert.equal(res.success, true);
	if (res.success) {
		assert.deepEqual(res.data.model, { provider: "antigravity", modelId: "gemini-3.8-flash" });
		assert.equal(res.data.thinkingLevel, "high");
	}
});

test("runtime-graph-live-metadata contract: accepts toolName, targetHint and startedAt on receipt", () => {
	const receipt = {
		taskId: 44,
		conversationId: 1,
		kind: "pi.tool",
		outcome: "completed",
		endedAt: 1793110000045,
		startedAt: 1793110000000,
		durationMs: 45,
		toolName: "bash",
		targetHint: "git status --short",
		preview: "bash: git status --short",
	};

	const res = runtimeTaskReceiptSchema.safeParse(receipt);
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.toolName, "bash");
		assert.equal(res.data.targetHint, "git status --short");
		assert.equal(res.data.startedAt, 1793110000000);
	}
});

test("runtime-graph-live-metadata contract: rejects oversized metadata fields", () => {
	const oversizedTool = runtimeTaskNodeSchema.safeParse({
		id: 1, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false,
		state: { status: "running" }, label: "test", toolName: "x".repeat(65),
	});
	assert.equal(oversizedTool.success, false);

	const oversizedTarget = runtimeTaskNodeSchema.safeParse({
		id: 1, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false,
		state: { status: "running" }, label: "test", targetHint: "x".repeat(129),
	});
	assert.equal(oversizedTarget.success, false);

	const oversizedThinking = runtimeTaskNodeSchema.safeParse({
		id: 1, kind: "pi.generation", conversationId: 1, background: false, abortRequested: false,
		state: { status: "running" }, label: "test", thinkingLevel: "x".repeat(33),
	});
	assert.equal(oversizedThinking.success, false);
});
