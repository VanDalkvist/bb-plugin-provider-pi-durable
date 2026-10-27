import test from "node:test";
import assert from "node:assert/strict";
import {
	runtimeTaskNodeSchema,
	runtimeTaskReceiptSchema,
	runtimeGraphSnapshotSchema,
} from "../src/runtime-graph/schema.ts";
import { TaskNames, sanitizeTargetHint } from "../src/runner/task-labels.ts";
import { RuntimeGraphSource } from "../src/runner/runtime-graph-source.ts";
import { RuntimeGraphReceiptsCollector } from "../src/runner/runtime-graph-receipts.ts";

test("runtime-graph-live-metadata contract: accepts sanitized metadata on live task node", () => {
	const node = {
		id: 42, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false,
		state: { status: "running", phase: "execute" }, label: "read: src/runner/index.ts",
		startedAt: 1793110000000, durationMs: 45, toolName: "read", targetHint: "src/runner/index.ts",
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
		id: 43, kind: "pi.generation", conversationId: 1, background: false, abortRequested: false,
		state: { status: "running", phase: "request" }, label: "gemini-3.8-flash (high)",
		startedAt: 1793110000000, durationMs: 12000,
		model: { provider: "antigravity", modelId: "gemini-3.8-flash" }, thinkingLevel: "high",
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
		taskId: 44, conversationId: 1, kind: "pi.tool", outcome: "completed",
		endedAt: 1793110000045, startedAt: 1793110000000, durationMs: 45,
		toolName: "bash", targetHint: "git status --short", preview: "bash: git status --short",
	};
	const res = runtimeTaskReceiptSchema.safeParse(receipt);
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.toolName, "bash");
		assert.equal(res.data.targetHint, "git status --short");
		assert.equal(res.data.startedAt, 1793110000000);
	}
});

test("runtime-graph-live-metadata: sanitizeTargetHint redacts sensitive tokens and limits length", () => {
	const bearer = sanitizeTargetHint("curl -H 'Authorization: Bearer secret_123456789' https://api.example.com");
	assert.ok(!bearer.includes("secret_123456789"));
	assert.ok(bearer.includes("[redacted]"));

	const ghp = sanitizeTargetHint("git clone https://ghp_abcdef123456@github.com/repo");
	assert.ok(!ghp.includes("ghp_abcdef123456"));
	assert.ok(ghp.includes("[redacted]"));

	const apiKey = sanitizeTargetHint("export api_key=AIzaSyD_SECRET_KEY");
	assert.ok(!apiKey.includes("AIzaSyD_SECRET_KEY"));
	assert.ok(apiKey.includes("[redacted]"));
});

test("runtime-graph-live-metadata: TaskNames learns structured toolName and targetHint from view", () => {
	const names = new TaskNames();
	const view: any = {
		conversation: {
			docs: { "pi.live": { tools: [{ taskId: 101, callId: "c1", name: "read" }] } },
			entries: [{ id: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/index.ts" } }] }] }],
		},
	};
	names.learn(view);
	const details = names.getDetails("101");
	assert.equal(details?.toolName, "read");
	assert.equal(details?.targetHint, "src/index.ts");
	assert.equal(details?.preview, "read: src/index.ts");
});

test("runtime-graph-live-metadata: fast tool finishing before debounce retains tool name and preview in receipt", async () => {
	const current: any = {
		tasks: {}, session: { id: "s1" },
		conversation: {
			docs: { "pi.live": { tools: [{ taskId: 202, callId: "c2", name: "bash" }] } },
			entries: [{ id: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } }] }] }],
		},
	};
	const viewSource = { current: () => current, subscribe: (_l: () => void) => () => {} };
	let commitListener: ((pub: { changes: readonly any[] }) => void) | undefined;
	const mockHarness = { subscribeCommits: (l: any) => { commitListener = l; return () => {}; }, getTask: async () => undefined };
	const collector = new RuntimeGraphReceiptsCollector(128);
	const source = new RuntimeGraphSource(
		viewSource as any, { sessionId: "s1", rootConversationId: "1", buildId: "b1" },
		{ debounceMs: 10, receipts: collector, harness: mockHarness },
	);

	commitListener?.({
		changes: [{
			type: "task",
			value: { id: 202, conversationId: 1, kind: "pi.tool", startedAt: 1000, endedAt: 1005, state: { status: "terminal", outcome: { status: "completed" } } },
		}],
	});

	await new Promise((r) => setTimeout(r, 25));
	const receipts = collector.getReceipts();
	assert.equal(receipts.length, 1);
	const r = receipts[0];
	assert.equal(r?.toolName, "bash");
	assert.equal(r?.targetHint, "npm test");
	assert.equal(r?.preview, "bash: npm test");
	assert.equal(r?.startedAt, 1000);
	assert.equal(r?.durationMs, 5);
	source.teardown();
});

test("runtime-graph-live-metadata: generation node extracts native model and thinkingLevel", async () => {
	const current: any = {
		tasks: { "303": { id: 303, kind: "pi.generation", conversationId: 1, background: false, abortRequested: false, state: { status: "running", phase: "request" } } },
		session: { id: "s1" },
		conversation: { docs: { "pi.agent": { model: { provider: "antigravity", modelId: "gemini-3.8-flash" }, thinkingLevel: "high" } } },
	};
	const viewSource = { current: () => current, subscribe: (_l: () => void) => () => {} };
	const snapshots: any[] = [];
	const source = new RuntimeGraphSource(viewSource as any, { sessionId: "s1", rootConversationId: "1", buildId: "b1" }, { debounceMs: 5 });
	source.subscribe((s) => snapshots.push(s));
	await new Promise((r) => setTimeout(r, 20));

	assert.ok(snapshots.length > 0);
	const genNode = snapshots[0]?.nodes["303"];
	assert.ok(genNode);
	assert.deepEqual(genNode.model, { provider: "antigravity", modelId: "gemini-3.8-flash" });
	assert.equal(genNode.thinkingLevel, "high");
	assert.ok(genNode.label.includes("gemini-3.8-flash"));
	source.teardown();
});

test("runtime-graph-live-metadata: subagent conversation maps logical owner to creator task", async () => {
	const current: any = {
		tasks: {}, session: { id: "s1" },
		conversation: { id: 1, docs: { "bb.subagents": { agents: { agent_1: { conversationId: 55, ownerTaskId: 10 } } } } },
	};
	const viewSource = { current: () => current, subscribe: (_l: () => void) => () => {} };
	const snapshots: any[] = [];
	const source = new RuntimeGraphSource(viewSource as any, { sessionId: "s1", rootConversationId: "1", buildId: "b1" }, { debounceMs: 5 });
	source.subscribe((s) => snapshots.push(s));
	await new Promise((r) => setTimeout(r, 20));

	assert.ok(snapshots.length > 0);
	const conv55 = snapshots[0]?.conversations["55"];
	assert.ok(conv55);
	assert.equal(conv55.owner?.conversationId, 1);
	assert.equal(conv55.owner?.taskId, 10);
	source.teardown();
});
