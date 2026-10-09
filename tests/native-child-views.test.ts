import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, Harness, InboxDoc, MemoryStorage, ToolResultEntry, ToolTask, watchEvents, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { TaskScheduler } from "../node_modules/@earendil-works/pi-durable/dist/harness/scheduler.js";
import { NativeChildViews, projectNativeChildSnapshot } from "../src/runner/native-child-views.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { NativeChildViewEventSchema } from "../src/native-child-contract.ts";
import type { z } from "zod";

function assistant(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "fixture", model: "fixture", timestamp: 1, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

let harness: Harness;
let views: NativeChildViews;
let parentId: ConversationId;
let target: { taskId: TaskId; childConversationId: ConversationId };
let sibling: { taskId: TaskId; childConversationId: ConversationId };
let resumes = 0;
const originalResume = TaskScheduler.prototype.resume;
const frames: z.infer<typeof NativeChildViewEventSchema>[] = [];
let observed: ((frame: z.infer<typeof NativeChildViewEventSchema>) => void) | undefined;

before(async () => {
	TaskScheduler.prototype.resume = function () { resumes++; };
	harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
	const root = await harness.root(BACKGROUND_CONTEXT);
	parentId = root.id;
	const rootState = await root.viewState(BACKGROUND_CONTEXT);
	const ownerMessage = assistant("parent");
	ownerMessage.content = [{ type: "toolCall", id: "call-child", name: "subagent", arguments: { task: "native task" } }];
	const ownerEntry = await harness.commit((tx) => tx.appendEntry(AssistantEntry, root.id, { model: [ownerMessage] }), BACKGROUND_CONTEXT);
	const makeChild = async (text: string) => {
		const taskId = await harness.commit((tx) => tx.createTask(ToolTask, { assistant: ownerEntry.id, callId: "call-child" }, { ownership: { kind: "conversation" }, conversationId: root.id }), BACKGROUND_CONTEXT);
		const childConversationId = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId } })).id, BACKGROUND_CONTEXT);
		await harness.commit(async (tx) => {
			const input = await tx.createSubmission({ conversationId: childConversationId, type: "input", status: "queued", requestId: `subagent:${taskId}` });
			(await tx.doc(InboxDoc, childConversationId)).items.push({ id: input.id, mode: "followUp", content: "native task" });
			await tx.appendEntry(AssistantEntry, childConversationId, { model: [assistant(text)] });
		}, BACKGROUND_CONTEXT);
		return { taskId, childConversationId };
	};
	target = await makeChild("target history");
	sibling = await makeChild("sibling history");
	views = new NativeChildViews({ harness, view: { current: () => ({ session: { id: "session", directory: "/memory/session", cwd: "/memory" }, conversation: rootState.value, conversations: [], models: [], notices: [] }), subscribe: () => () => {} } }, (frame) => { frames.push(frame); observed?.(frame); });
});

after(async () => {
	try { await views?.close(); await harness?.close(BACKGROUND_CONTEXT); }
	finally { TaskScheduler.prototype.resume = originalResume; }
});

function command(viewId: string, child = target) {
	return { type: "native-child-view-attach", durableSessionId: "session", parentConversationId: parentId, ...child, viewId };
}

describe("native child transcript projection", () => {
	it("replays only the existing child's history and attaches without scheduling work", { timeout: 2000 }, async () => {
		await views.handle(command("target-view"));
		assert.equal(resumes, 0);
		assert.ok(frames.some((frame) => frame.viewId === "target-view" && frame.event.type === "message_end" && JSON.stringify(frame.event).includes("target history")));
		assert.equal(frames.some((frame) => frame.viewId === "target-view" && JSON.stringify(frame.event).includes("sibling history")), false);
		assert.equal(frames.some((frame) => frame.event.type === "agent_end"), false, "queued native input is not presented as completed");
		const count = frames.length;
		await views.handle(command("target-view"));
		assert.equal(frames.length, count, "repeated attachment does not replay history to the same view");
	});

	it("streams native commits into the exact child view while the sibling remains isolated", { timeout: 2000 }, async () => {
		await views.handle(command("sibling-view", sibling));
		const streamed = new Promise<void>((resolve) => { observed = (frame) => { if (frame.viewId === "target-view" && frame.event.type === "message_end" && JSON.stringify(frame.event).includes("new target answer")) resolve(); }; });
		await harness.commit((tx) => tx.appendEntry(AssistantEntry, target.childConversationId, { model: [assistant("new target answer")] }), BACKGROUND_CONTEXT);
		await streamed;
		observed = undefined;
		assert.equal(frames.some((frame) => frame.viewId === "sibling-view" && JSON.stringify(frame.event).includes("new target answer")), false);
		assert.equal(resumes, 0);
	});

	it("reopens full large history, tool action/result and usage without submitting native work", { timeout: 2000 }, async () => {
		const call = assistant("🧭".repeat(18_000));
		call.content.push({ type: "toolCall", id: "tool-history", name: "lookup", arguments: { key: "existing" } });
		call.stopReason = "toolUse";
		call.usage.input = 17;
		await harness.commit(async (tx) => {
			await tx.appendEntry(AssistantEntry, target.childConversationId, { model: [call] });
			await tx.appendEntry(ToolResultEntry, target.childConversationId, { model: [{ role: "toolResult", toolCallId: "tool-history", toolName: "lookup", content: [{ type: "text", text: "real tool result" }], isError: false, timestamp: 2 }], data: { diagnostics: [] } });
		}, BACKGROUND_CONTEXT);
		await views.handle(command("large-history"));
		const history = frames.filter((frame) => frame.viewId === "large-history").map((frame) => frame.event);
		assert.ok(history.some((event) => event.type === "message_end" && JSON.stringify(event).includes("🧭".repeat(18_000)) && JSON.stringify(event).includes('"input":17')));
		assert.ok(history.some((event) => event.type === "tool_execution_start" && event.toolCallId === "tool-history"));
		assert.ok(history.some((event) => event.type === "tool_execution_end" && event.result === "real tool result"));
		assert.equal(resumes, 0);
	});

	it("overflow snapshot replays only unseen entries and nonduplicated partial indices", { timeout: 2000 }, async () => {
		const stream = await watchEvents(harness, target.childConversationId, BACKGROUND_CONTEXT);
		try {
			const events: BBWireEvent[] = [];
			const seen = new Set<number>();
			const partials = new Map<number, string>();
			const first = { ...stream.snapshot, generation: { attempt: 1, message: { ...assistant(""), content: [{ type: "thinking" as const, thinking: "reason" }, { type: "text" as const, text: "hello" }] } } };
			projectNativeChildSnapshot(first, (event) => events.push(event), undefined, seen, partials);
			const before = events.length;
			projectNativeChildSnapshot({ ...first, generation: { attempt: 1, message: { ...assistant(""), content: [{ type: "thinking" as const, thinking: "reason" }, { type: "text" as const, text: "hello world" }] } } }, (event) => events.push(event), undefined, seen, partials);
			assert.deepEqual(events.slice(before), [{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " world" } }]);
		} finally { await stream.stop(); }
		assert.equal(resumes, 0);
	});

	it("denies foreign session, mismatched ownership and view-id rebinding", { timeout: 2000 }, async () => {
		await assert.rejects(views.handle({ ...command("foreign"), durableSessionId: "foreign" }), /denied/);
		await assert.rejects(views.handle({ ...command("wrong-owner"), taskId: sibling.taskId }), /denied/);
		await assert.rejects(views.handle(command("target-view", sibling)), /rebind denied/);
		assert.equal(resumes, 0);
	});

	it("detaching and reopening only reads history and leaves native parent and sibling unchanged", { timeout: 2000 }, async () => {
		const parentBefore = await harness.getTask(target.taskId, BACKGROUND_CONTEXT);
		const siblingBefore = await harness.getTask(sibling.taskId, BACKGROUND_CONTEXT);
		await views.handle({ ...command("target-view"), type: "native-child-view-detach" });
		await views.handle(command("reopened-target"));
		assert.ok(frames.some((frame) => frame.viewId === "reopened-target" && frame.event.type === "message_end" && JSON.stringify(frame.event).includes("new target answer")));
		assert.deepEqual(await harness.getTask(target.taskId, BACKGROUND_CONTEXT), parentBefore);
		assert.deepEqual(await harness.getTask(sibling.taskId, BACKGROUND_CONTEXT), siblingBefore);
		assert.equal(resumes, 0);
	});

	it("projects queued native cancellation as a terminal view without cancelling the parent or sibling", { timeout: 2000 }, async () => {
		const parentBefore = await harness.getTask(target.taskId, BACKGROUND_CONTEXT);
		const siblingBefore = await harness.getTask(sibling.taskId, BACKGROUND_CONTEXT);
		const finished = new Promise<void>((resolve) => { observed = (frame) => { if (frame.viewId === "reopened-target" && frame.event.type === "agent_end") resolve(); }; });
		const child = await harness.conversation(target.childConversationId, BACKGROUND_CONTEXT);
		assert.ok(child);
		await child.abort(BACKGROUND_CONTEXT, { background: true });
		await finished;
		observed = undefined;
		const streamedTerminal = frames.filter((frame) => frame.viewId === "reopened-target" && (frame.event.type === "turn_end" || frame.event.type === "agent_end"));
		assert.deepEqual(streamedTerminal.map((frame) => frame.event.type), ["turn_end", "agent_end"], "live cancellation must close its turn exactly once without a second snapshot");
		assert.deepEqual(await harness.getTask(target.taskId, BACKGROUND_CONTEXT), parentBefore);
		assert.deepEqual(await harness.getTask(sibling.taskId, BACKGROUND_CONTEXT), siblingBefore);
		assert.equal(frames.some((frame) => frame.viewId === "sibling-view" && frame.event.type === "agent_end"), false);
		const beforeReopen = resumes;
		await views.handle(command("terminal-history"));
		assert.equal(resumes, beforeReopen);
		const terminal = frames.find((frame) => frame.viewId === "terminal-history" && frame.event.type === "agent_end");
		assert.equal(terminal?.event.status, "interrupted");
		const boundary = new DeltaTranslator().translate(terminal!.event, { threadId: "terminal-history" }).find((delta) => delta.kind === "turn.boundary");
		assert.deepEqual(boundary, { kind: "turn.boundary", status: "interrupted", claimIfIdle: true });
	});

	it("projects a failed native settlement as failed, without altering its parent or sibling", { timeout: 2000 }, async () => {
		const parentBefore = await harness.getTask(target.taskId, BACKGROUND_CONTEXT);
		const failed = new Promise<void>((resolve) => { observed = (frame) => { if (frame.viewId === "sibling-view" && frame.event.type === "agent_end") resolve(); }; });
		await harness.commit(async (tx) => {
			const submission = await tx.submissionByRequest(sibling.childConversationId, `subagent:${sibling.taskId}`);
			assert.ok(submission);
			tx.settleSubmission(submission.id, { status: "unanswered", reason: "model_error" });
			const inbox = await tx.doc(InboxDoc, sibling.childConversationId);
			inbox.items.splice(inbox.items.findIndex((item) => item.id === submission.id), 1);
		}, BACKGROUND_CONTEXT);
		await failed;
		observed = undefined;
		const liveTerminal = frames.filter((frame) => frame.viewId === "sibling-view" && (frame.event.type === "turn_end" || frame.event.type === "agent_end"));
		assert.deepEqual(liveTerminal.map((frame) => frame.event.type), ["turn_end", "agent_end"], "live failed settlement closes exactly one turn");
		assert.equal(liveTerminal[1]?.event.status, "failed");
		assert.deepEqual(await harness.getTask(target.taskId, BACKGROUND_CONTEXT), parentBefore);
		const afterSettlement = resumes;
		await views.handle(command("failed-history", sibling));
		assert.equal(resumes, afterSettlement, "view replay must not schedule child work");
		assert.ok(frames.some((frame) => frame.viewId === "failed-history" && frame.event.type === "agent_end" && frame.event.status === "failed"));
	});
});
