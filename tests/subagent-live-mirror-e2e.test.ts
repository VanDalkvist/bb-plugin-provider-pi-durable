import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiThreadSession } from "../src/host/session.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { handleTurnStart } from "../src/host/bridge-router.ts";
import type { RunnerEvent } from "../src/host/types.ts";

test("End-to-End Mirror Sync: Subagent execution events stream into child BB thread without duplicate prompt or empty transcript", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];

	let promptCallCount = 0;
	let promptedText = "";
	let promptedConvId: string | undefined;

	const testDir = mkdtempSync(join(tmpdir(), "pi-e2e-mirror-"));
	const sessionFilePath = join(testDir, "session.sqlite");

	// 1. Create a session that mimics the live PiThreadSession
	const session = new PiThreadSession(
		{
			threadId: "thr_parent_live",
			providerThreadId: "pi_durable_live",
			sessionFilePath,
			sessionDir: testDir,
			extensionPath: "/tmp/ext",
		},
		(method, params) => notifications.push({ method, params }),
	);

	// Intercept prompt calls to ensure no duplicate LLM prompt is executed
	session.prompt = async (text: string, convId?: string) => {
		promptCallCount++;
		promptedText = text;
		promptedConvId = convId;
	};

	const registry = new SessionRegistry((method, params) => notifications.push({ method, params }));
	(registry as any).sessions.set("thr_parent_live", session);

	const ctx = {
		registry,
		sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
		sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
		sendError: () => {},
	};

	try {
		// --- PHASE 1: Subagent tool starts in runner ---
		// Runner announces that subagent conversation 77 has started for task "Perform deep analysis"
		session.markSubagentActive("77", { task: "Perform deep analysis", parentToolCallId: "call_sub_1" });

		// --- PHASE 2: Runner emits early events BEFORE BB thread spawn finishes ---
		const earlyTurnStart: RunnerEvent = {
			type: "turn_start",
			conversationId: "77",
			parentRef: "call_sub_1",
		};
		const earlyDelta1: RunnerEvent = {
			type: "message_update",
			conversationId: "77",
			parentRef: "call_sub_1",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Step 1: Inspecting schema...\n",
			},
		};

		await (session as any).handleRunnerEvent(earlyTurnStart);
		await (session as any).handleRunnerEvent(earlyDelta1);

		// At this point, child thread is not yet registered. Events are buffered.
		assert.equal(session.getThreadIdForConversation("77"), undefined);

		// --- PHASE 3: spawnSubthreadInBb finishes and BB calls turn/start on the child thread ---
		// BB spawned thread thr_bb_child_77 with parent thr_parent_live
		await handleTurnStart(
			"req_bb_turn_1",
			{
				threadId: "thr_bb_child_77",
				providerThreadId: "pi_durable_child_rand_999",
				parentThreadId: "thr_parent_live",
				input: [{ type: "text", text: "Perform deep analysis" }],
				clientRequestId: "creq_23456789ab",
			},
			ctx,
		);

		// Verify Active Subagent Guard prevented duplicate prompt!
		assert.equal(promptCallCount, 0, "Active subagent must NOT be prompted twice!");

		// Verify child thread was bound to conversation 77
		assert.equal(session.getThreadIdForConversation("77"), "thr_bb_child_77");

		// Verify turn.open was emitted immediately for thr_bb_child_77 so BB watchdog does not timeout!
		const childDeltas = notifications
			.filter((n) => n.method === "thread/delta" && n.params.threadId === "thr_bb_child_77")
			.flatMap((n) => n.params.deltas as any[]);

		assert.ok(childDeltas.some((d) => d.kind === "turn.open"), "Child thread MUST receive turn.open!");

		// Verify early buffered events were flushed to the child thread!
		assert.ok(
			childDeltas.some((d) => d.kind === "item.textDelta" && d.text.includes("Step 1: Inspecting schema...")),
			"Early buffered text deltas MUST be delivered to child thread!",
		);

		// --- PHASE 4: Subagent executes tool (e.g. bash) and streams in real-time ---
		const toolStart: RunnerEvent = {
			type: "tool_execution_start",
			conversationId: "77",
			parentRef: "call_sub_1",
			toolCallId: "call_sub_1:bash_1",
			toolName: "bash",
			args: { command: "git status" },
		};
		const toolEnd: RunnerEvent = {
			type: "tool_execution_end",
			conversationId: "77",
			parentRef: "call_sub_1",
			toolCallId: "call_sub_1:bash_1",
			toolName: "bash",
			result: "nothing to commit, working tree clean",
			isError: false,
		};
		const liveDelta2: RunnerEvent = {
			type: "message_update",
			conversationId: "77",
			parentRef: "call_sub_1",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Step 2: Verification complete: PASS\n",
			},
		};
		await (session as any).handleRunnerEvent(toolStart);
		await (session as any).handleRunnerEvent(toolEnd);
		await (session as any).handleRunnerEvent(liveDelta2);

		// --- PHASE 5: Subagent finishes (agent_end) ---
		const agentEnd: RunnerEvent = {
			type: "agent_end",
			conversationId: "77",
			parentRef: "call_sub_1",
		};
		await (session as any).handleRunnerEvent(agentEnd);

		// Verify child thread received turn.boundary with completed status!
		const updatedChildDeltas = notifications
			.filter((n) => n.method === "thread/delta" && n.params.threadId === "thr_bb_child_77")
			.flatMap((n) => n.params.deltas as any[]);

		assert.ok(
			updatedChildDeltas.some((d) => d.kind === "item.textDelta" && d.text.includes("Step 2: Verification complete")),
			"Live text deltas MUST be delivered to child thread!",
		);

		// Verify child thread received tool execution without parentRef
		const childToolOpen = updatedChildDeltas.find((d) => d.kind === "item.open" && d.item?.type === "command");
		assert.ok(childToolOpen, "Child thread must receive tool execution item.open");
		assert.equal(childToolOpen.key?.parentRef, undefined, "Child tool item must not have parentRef");

		const childToolClose = updatedChildDeltas.find((d) => d.kind === "item.close" && d.item?.type === "command");
		assert.ok(childToolClose, "Child thread must receive tool execution item.close");
		assert.equal(childToolClose.status, "completed");

		assert.ok(
			updatedChildDeltas.some((d) => d.kind === "turn.boundary" && d.status === "completed"),
			"Child thread MUST receive turn.boundary completed!",
		);

		// Verify parent thread also received card updates with parentRef
		const parentDeltas = notifications
			.filter((n) => n.method === "thread/delta" && n.params.threadId === "thr_parent_live")
			.flatMap((n) => n.params.deltas as any[]);

		assert.ok(
			parentDeltas.some((d) => d.key?.parentRef === "call_sub_1"),
			"Parent thread MUST receive in-place card deltas with parentRef!",
		);

		// --- PHASE 6: Continuation in child thread ---
		// User types "Explain step 1" in the child thread thr_bb_child_77
		await handleTurnStart(
			"req_bb_turn_2",
			{
				threadId: "thr_bb_child_77",
				providerThreadId: "pi_durable_child_rand_999",
				parentThreadId: "thr_parent_live",
				input: [{ type: "text", text: "Explain step 1" }],
				clientRequestId: "creq_3456789abc",
			},
			ctx,
		);

		// Now prompt SHOULD be called, targeting conversation 77!
		assert.equal(promptCallCount, 1, "User follow-up MUST prompt the subagent conversation");
		assert.equal(promptedText, "Explain step 1");
		assert.equal(promptedConvId, "77", "Follow-up prompt MUST target conversation 77");
	} finally {
		session.kill();
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {}
	}
});
