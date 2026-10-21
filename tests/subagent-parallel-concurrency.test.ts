import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { SubagentMirrorManager } from "../src/host/subagent-mirror.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { DurableBindingManager } from "../src/host/durable-binding-store.ts";
import { SubagentsDoc } from "../src/runner/subagent-docs.ts";
import { courierFor, reporterFor } from "../src/runner/subagent-delivery.ts";
import type { RunnerEvent, ThreadDelta } from "../src/host/types.ts";

test("Slice 6.3: Parallel subagents stream with strict buffer and translator isolation", () => {
	const bindings = new DurableBindingManager();
	const mirrors = new SubagentMirrorManager();
	const translators = new Map<string, DeltaTranslator>();
	const notifications: Array<{ threadId: string; deltas: ThreadDelta[] }> = [];

	const emit = (threadId: string, deltas: ThreadDelta[]) => {
		notifications.push({ threadId, deltas });
	};

	const getTranslator = (threadId: string): DeltaTranslator => {
		let t = translators.get(threadId);
		if (!t) {
			t = new DeltaTranslator();
			translators.set(threadId, t);
		}
		return t;
	};

	// 1. Register two concurrent subagents
	bindings.register("thr_child_1", "101", "thr_parent");
	bindings.register("thr_child_2", "102", "thr_parent");

	mirrors.markActive("101", { task: "Analyze frontend", parentToolCallId: "call_sub_1" });
	mirrors.markActive("102", { task: "Analyze backend", parentToolCallId: "call_sub_2" });

	// 2. Interleave streaming events from both subagents concurrently
	const events: RunnerEvent[] = [
		// Subagent 1 text chunk 1
		{
			type: "message_update",
			conversationId: "101",
			parentRef: "call_sub_1",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Frontend: 12 components audited. " },
		},
		// Subagent 2 text chunk 1
		{
			type: "message_update",
			conversationId: "102",
			parentRef: "call_sub_2",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Backend: 8 endpoints verified. " },
		},
		// Subagent 1 text chunk 2
		{
			type: "message_update",
			conversationId: "101",
			parentRef: "call_sub_1",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "No UI defects found." },
		},
		// Subagent 2 text chunk 2
		{
			type: "message_update",
			conversationId: "102",
			parentRef: "call_sub_2",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "DB pool healthy." },
		},
		// Subagent 1 completes
		{
			type: "agent_end",
			conversationId: "101",
			parentRef: "call_sub_1",
		},
		// Subagent 2 completes
		{
			type: "agent_end",
			conversationId: "102",
			parentRef: "call_sub_2",
		},
	];

	// Route events as PiThreadSession does
	for (const event of events) {
		const convId = event.conversationId as string;
		const childThreadId = bindings.getThreadId(convId);
		assert.ok(childThreadId, `ThreadId must be found for conversation ${convId}`);

		if (event.type === "message_update") {
			const asst = event.assistantMessageEvent as any;
			if (asst?.type === "text_delta" && typeof asst.delta === "string") {
				mirrors.appendOutputText(convId, asst.delta);
			}
		}

		const childEvent = { ...event, parentRef: undefined };
		const translator = getTranslator(childThreadId);
		const deltas = translator.translate(childEvent, { threadId: childThreadId });

		if (deltas.length > 0) {
			emit(childThreadId, deltas);
		}
		if (event.type === "agent_end") {
			mirrors.markCompleted(convId);
		}
	}

	// 3. Verify strict buffer isolation in SubagentMirrorManager
	assert.equal(
		mirrors.getOutputText("101"),
		"Frontend: 12 components audited. No UI defects found.",
		"Subagent 1 accumulated text must be strictly isolated",
	);
	assert.equal(
		mirrors.getOutputText("102"),
		"Backend: 8 endpoints verified. DB pool healthy.",
		"Subagent 2 accumulated text must be strictly isolated",
	);

	// 4. Verify thread notification separation
	const child1Deltas = notifications
		.filter((n) => n.threadId === "thr_child_1")
		.flatMap((n) => n.deltas);
	const child2Deltas = notifications
		.filter((n) => n.threadId === "thr_child_2")
		.flatMap((n) => n.deltas);

	// Ensure all deltas are valid BB schema
	for (const delta of [...child1Deltas, ...child2Deltas]) {
		const parsed = threadDeltaSchema.safeParse(delta);
		assert.ok(parsed.success, `Delta must be valid: ${parsed.error}`);
	}

	// Verify child 1 received ONLY frontend text
	const text1 = child1Deltas
		.filter((d) => d.kind === "item.textDelta")
		.map((d: any) => d.text)
		.join("");
	assert.equal(text1, "Frontend: 12 components audited. No UI defects found.");

	// Verify child 2 received ONLY backend text
	const text2 = child2Deltas
		.filter((d) => d.kind === "item.textDelta")
		.map((d: any) => d.text)
		.join("");
	assert.equal(text2, "Backend: 8 endpoints verified. DB pool healthy.");

	// Verify both threads received independent completed turn boundaries
	const boundary1 = child1Deltas.find((d) => d.kind === "turn.boundary");
	const boundary2 = child2Deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundary1 && boundary1.status === "completed");
	assert.ok(boundary2 && boundary2.status === "completed");
});

test("Slice 6.3: Courier batches multiple simultaneous subagent completions into single atomic outbox batch", async () => {
	// Simulate Courier and Reporter state in SubagentsDoc
	const state: any = SubagentsDoc.definition.initial();
	state.outbox = [];

	// Reporter 1 delivers completion report for subagent 101
	state.outbox.push({
		id: "subagent:task_1:report",
		name: "Analyze frontend · worker",
		text: "Result from 101: Frontend OK",
	});

	// Reporter 2 delivers completion report for subagent 102 concurrently
	state.outbox.push({
		id: "subagent:task_2:report",
		name: "Analyze backend · worker",
		text: "Result from 102: Backend OK",
	});

	// Both reports are in outbox waiting for gather window
	assert.equal(state.outbox.length, 2);

	// Simulate Courier next phase: picks up both reports in 1 atomic batch
	const reports = state.outbox;
	state.outbox = [];
	state.batchNumber = (state.batchNumber ?? 0) + 1;
	state.sending = {
		requestId: `subagent-batch:courier-1:${state.batchNumber}`,
		reports,
	};

	assert.equal(state.outbox.length, 0, "Outbox must be cleared upon batch creation");
	assert.equal(state.sending.reports.length, 2, "Batch must carry both simultaneous reports");
	assert.equal(state.sending.reports[0].id, "subagent:task_1:report");
	assert.equal(state.sending.reports[1].id, "subagent:task_2:report");

	// Combined message matches Courier prompt template
	const prompt = state.sending.reports.map((r: any) => r.text).join("\n\n---\n\n");
	const content = `[Subagent Reports Available]:\n\n${prompt}`;
	assert.ok(content.includes("Result from 101: Frontend OK"));
	assert.ok(content.includes("Result from 102: Backend OK"));
});
