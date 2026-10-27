import test from "node:test";
import assert from "node:assert/strict";
import { SubagentMirrorManager } from "../src/host/subagent-mirror.ts";
import { SessionSubagentHandler } from "../src/host/session-subagent-handler.ts";
import type { RunnerEvent } from "../src/host/types.ts";

test("SubagentMirrorManager: coalesces replaceable runtime_graph_snapshot events", () => {
	const manager = new SubagentMirrorManager();
	manager.markActive("21848", { task: "subagent 1" });

	// Buffer 5 replaceable graph snapshot events
	for (let i = 1; i <= 5; i++) {
		manager.bufferEvent("21848", {
			type: "runtime_graph_snapshot",
			snapshot: { revision: i } as any,
		});
	}

	const buffered = manager.drainBufferedEvents("21848");
	// Should have coalesced down to exactly 1 latest snapshot, not 5
	assert.equal(buffered.length, 1);
	assert.equal((buffered[0] as any).snapshot.revision, 5);
});

test("SubagentMirrorManager: consumeCompleted releases heavy event buffers immediately", () => {
	const manager = new SubagentMirrorManager();
	manager.markActive("21848", { task: "subagent 1" });
	manager.bufferEvent("21848", { type: "turn_start" } as any);
	manager.bufferEvent("21848", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } } as any);

	manager.markCompleted("21848", "Final answer");
	manager.consumeCompleted("21848");

	// Heavy event buffer and mirror must be released upon consumption
	const remaining = manager.drainBufferedEvents("21848");
	assert.equal(remaining.length, 0);
	assert.equal(manager.getState("21848"), undefined);
});

test("SubagentMirrorManager: bounds buffered event count and outputText length", () => {
	const manager = new SubagentMirrorManager();
	manager.markActive("21848", { task: "subagent 1" });

	// Push 150 unique events
	for (let i = 0; i < 150; i++) {
		manager.bufferEvent("21848", { type: "tool_execution_update", toolCallId: `call_${i}` } as any);
	}

	const buffered = manager.drainBufferedEvents("21848");
	// Max bounded capacity is 100
	assert.ok(buffered.length <= 100, `Buffered length ${buffered.length} must be <= 100`);
	assert.equal(manager.getState("21848")?.isTruncated, true, "Must honestly mark truncated");

	// Test text bounding (push 100KB)
	const chunk = "a".repeat(1024);
	for (let i = 0; i < 100; i++) {
		manager.appendOutputText("21848", chunk);
	}
	const output = manager.getOutputText("21848");
	assert.ok(output.length <= 65536, `Output text length ${output.length} must be <= 64KB`);
});

test("SessionSubagentHandler: ignores root graph snapshots for completed mirrors", () => {
	const handler = new SessionSubagentHandler();
	handler.markActive("21848", { task: "subtask" });
	handler.markCompleted("21848", "done");

	const rootSnapshotEvent: RunnerEvent = {
		type: "runtime_graph_snapshot",
		snapshot: {
			scope: { rootConversationId: "1" },
			conversations: { "21848": {} },
		} as any,
	};

	handler.handleEvent(
		rootSnapshotEvent,
		{ options: { threadId: "thr_parent" } as any, getThreadIdForConversation: () => undefined, registerThread: () => {} },
		() => {},
	);

	const state = handler.getState("21848");
	assert.equal(state?.status, "completed");
	assert.equal(handler.getOutputText("21848"), "done");
});
