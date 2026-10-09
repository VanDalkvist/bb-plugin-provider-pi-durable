import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, Harness, InboxDoc, LiveDoc, MemoryStorage, ROOT_CONVERSATION_ID, ToolTask } from "@earendil-works/pi-durable";
import { TaskScheduler } from "../node_modules/@earendil-works/pi-durable/dist/harness/scheduler.js";
import type { ConversationId, ConversationView, EntryId, Harness as HarnessType, TaskId } from "@earendil-works/pi-durable";
import { inspectNativeChildIdentity, inspectNativeChildIntent } from "../src/runner/native-child-inspection.ts";
import { handleActiveSessionCommand } from "../src/runner/session-commands.ts";
import { resumeSchedulerOnOpen } from "../src/runner/runtime.ts";
import { parseCliArgs } from "../src/runner/cli-args.ts";

let harness: HarnessType;
let parentId: ConversationId;
let childId: ConversationId;
let taskId: TaskId;
let assistantId: EntryId;
let rootView: ConversationView;
let schedulerResumeCalls = 0;
const originalResume = TaskScheduler.prototype.resume;

before(async () => {
	TaskScheduler.prototype.resume = function () { schedulerResumeCalls++; };
	harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
	const parent = await harness.root(BACKGROUND_CONTEXT);
	parentId = parent.id;
	assert.equal(parentId, ROOT_CONVERSATION_ID, "fixture uses the installed Durable root conversation id");
	rootView = (await parent.viewState(BACKGROUND_CONTEXT)).value;
	const assistant = await parent.commit((tx) => tx.appendEntry(AssistantEntry, parentId, {
		model: [{ role: "assistant", content: [{ type: "toolCall", id: "call-native-child", name: "subagent", arguments: { task: "inspect" } }], timestamp: 1 } as unknown as AssistantMessage],
	}), BACKGROUND_CONTEXT);
	assistantId = assistant.id;
	taskId = await parent.commit((tx) => tx.createTask(ToolTask, { assistant: assistantId, callId: "call-native-child" }, { ownership: { kind: "conversation" } }), BACKGROUND_CONTEXT);
	childId = await parent.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId } })).id, BACKGROUND_CONTEXT);
	const child = await harness.conversation(childId, BACKGROUND_CONTEXT);
	assert.ok(child);
	await child.submit({ type: "input", content: "inspect", requestId: `subagent:${taskId}` }, BACKGROUND_CONTEXT);
	assert.equal(schedulerResumeCalls, 1, "fixture intercepted the submit-triggered resume and kept scheduling paused");
});

after(async () => {
	await harness.close(BACKGROUND_CONTEXT);
	TaskScheduler.prototype.resume = originalResume;
});

describe("native child identity inspection", () => {
	it("proves pre-submit intent without manufacturing submitted provenance or scheduling work", { timeout: 2000 }, async () => {
		const nativeTask = await harness.commit((tx) => tx.createTask(ToolTask, { assistant: assistantId, callId: "call-native-child" }, { ownership: { kind: "conversation" }, conversationId: parentId }), BACKGROUND_CONTEXT);
		const nativeChild = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId: nativeTask } })).id, BACKGROUND_CONTEXT);
		const request = { durableSessionId: "actual-session-id", parentConversationId: parentId, childConversationId: nativeChild, taskId: nativeTask };
		const resumesBefore = schedulerResumeCalls;
		const intent = await inspectNativeChildIntent(harness, "actual-session-id", request, BACKGROUND_CONTEXT);
		assert.deepEqual(intent, { valid: true, proof: { valid: true, phase: "intent", ...request, requestId: `subagent:${nativeTask}` } });
		assert.deepEqual(await inspectNativeChildIdentity(harness, "actual-session-id", request, BACKGROUND_CONTEXT), { valid: false, reason: "not_native_child" });
		assert.equal(await harness.commit((tx) => tx.submissionByRequest(nativeChild, `subagent:${nativeTask}`), BACKGROUND_CONTEXT), undefined);
		assert.equal(schedulerResumeCalls, resumesBefore, "read-only intent verification must not resume the scheduler");
		assert.deepEqual(await inspectNativeChildIntent(harness, "wrong-session", request, BACKGROUND_CONTEXT), { valid: false, reason: "not_native_child" });
		assert.deepEqual(await inspectNativeChildIntent(harness, "actual-session-id", { ...request, taskId }, BACKGROUND_CONTEXT), { valid: false, reason: "not_native_child" });
		let response: unknown;
		let failure: string | undefined;
		await handleActiveSessionCommand({ type: "native-child-intent", id: "rpc-intent", ...request }, {
			harness,
			view: { current: () => ({ session: { id: "actual-session-id", directory: "/memory", cwd: "/memory" }, conversation: rootView }) },
			controller: { submit: async () => { throw new Error("intent must not submit"); }, compact: async () => {}, abort: async () => { throw new Error("intent must not abort"); }, setModel: async () => {}, setThinkingLevel: async () => {} },
		}, { getAvailableSnapshot: () => [], getModel: () => undefined }, parseCliArgs([]), {
			success: (_id, command, data) => { assert.equal(command, "native-child-intent"); response = data; },
			error: (_id, _command, message) => { failure = message; },
		});
		assert.equal(failure, undefined);
		assert.deepEqual(response, intent.valid ? intent.proof : undefined);
		assert.equal(schedulerResumeCalls, resumesBefore);
		const child = await harness.conversation(nativeChild, BACKGROUND_CONTEXT);
		assert.ok(child);
		await child.submit({ type: "input", content: "native request", requestId: `subagent:${nativeTask}` }, BACKGROUND_CONTEXT);
		assert.equal(schedulerResumeCalls, resumesBefore + 1, "only the original native submit requests scheduling; fixture intercepts it");
		const submitted = await inspectNativeChildIdentity(harness, "actual-session-id", request, BACKGROUND_CONTEXT);
		assert.ok(submitted.valid);
		assert.equal("phase" in submitted.proof, false, "submitted proof preserves its existing contract");
	});
	it("stops only the verified native child conversation and leaves parent and sibling intact", { timeout: 2000 }, async () => {
		const makeChild = async () => {
			const owner = await harness.commit((tx) => tx.createTask(ToolTask, { assistant: assistantId, callId: "call-native-child" }, { ownership: { kind: "conversation" }, conversationId: parentId }), BACKGROUND_CONTEXT);
			const id = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId: owner } })).id, BACKGROUND_CONTEXT);
			const child = await harness.conversation(id, BACKGROUND_CONTEXT);
			assert.ok(child);
			// Reproduce queued native input in memory without admitting an executable pi.turn task.
			await harness.commit(async (tx) => {
				const submission = await tx.createSubmission({ conversationId: id, type: "input", status: "queued", requestId: `subagent:${owner}` });
				(await tx.doc(InboxDoc, id)).items.push({ id: submission.id, mode: "followUp", content: "native task" });
			}, BACKGROUND_CONTEXT);
			return { owner, id };
		};
		const target = await makeChild();
		const sibling = await makeChild();
		const parentBefore = await harness.getTask(target.owner, BACKGROUND_CONTEXT);
		const siblingBefore = await harness.getTask(sibling.owner, BACKGROUND_CONTEXT);
		const siblingInputBefore = await harness.commit((tx) => tx.submissionByRequest(sibling.id, `subagent:${sibling.owner}`), BACKGROUND_CONTEXT);
		const resumesBefore = schedulerResumeCalls;
		let response: unknown;
		let failure: string | undefined;
		await handleActiveSessionCommand({
			type: "native-child-stop", id: "rpc-child-stop", durableSessionId: "actual-session-id",
			parentConversationId: parentId, childConversationId: target.id, taskId: target.owner,
		}, {
			harness,
			view: { current: () => ({ session: { id: "actual-session-id", directory: "/memory", cwd: "/memory" }, conversation: rootView }) },
			controller: { submit: async () => { throw new Error("child stop must not submit"); }, compact: async () => {}, abort: async () => { throw new Error("child stop must not abort parent"); }, setModel: async () => {}, setThinkingLevel: async () => {} },
		}, { getAvailableSnapshot: () => [], getModel: () => undefined }, parseCliArgs([]), {
			success: (_id, command, data) => { assert.equal(command, "native-child-stop"); response = data; },
			error: (_id, _command, message) => { failure = message; },
		});
		assert.equal(failure, undefined);
		assert.deepEqual(response, { accepted: true, requestId: `subagent:${target.owner}`, conversationId: target.id });
		const targetInput = await harness.commit((tx) => tx.submissionByRequest(target.id, `subagent:${target.owner}`), BACKGROUND_CONTEXT);
		assert.ok(targetInput);
		assert.notEqual(targetInput.status, "queued", "native queued input is withdrawn by the child-scoped abort");
		assert.deepEqual(await harness.getTask(target.owner, BACKGROUND_CONTEXT), parentBefore, "the parent's native tool task is not directly aborted");
		assert.deepEqual(await harness.getTask(sibling.owner, BACKGROUND_CONTEXT), siblingBefore);
		assert.deepEqual(await harness.commit((tx) => tx.submissionByRequest(sibling.id, `subagent:${sibling.owner}`), BACKGROUND_CONTEXT), siblingInputBefore);
		assert.equal(schedulerResumeCalls, resumesBefore + 1, "native abort requests scheduling once; fixture keeps execution paused");
	});

	it("proves the native pi.tool owner, subagent tool call, child ownership, and exact request id", async () => {
		const result = await inspectNativeChildIdentity(harness, "actual-session-id", {
			durableSessionId: "actual-session-id", parentConversationId: parentId, childConversationId: childId, taskId,
		}, BACKGROUND_CONTEXT);
		assert.deepEqual(result, { valid: true, proof: {
			valid: true,
			durableSessionId: "actual-session-id",
			parentConversationId: parentId,
			childConversationId: childId,
			taskId,
			requestId: `subagent:${taskId}`,
		} });
	});

	it("accepts the production RPC envelope through the shipped command dispatcher", async () => {
		let response: unknown;
		let failure: string | undefined;
		await handleActiveSessionCommand({
			id: "rpc-identity-1",
			type: "native-child-identity",
			durableSessionId: "actual-session-id",
			parentConversationId: parentId,
			childConversationId: childId,
			taskId,
		}, {
			harness,
			view: { current: () => ({ session: { id: "actual-session-id", directory: "/memory", cwd: "/memory" }, conversation: rootView }) },
			controller: { submit: async () => {}, compact: async () => {}, abort: async () => {}, setModel: async () => {}, setThinkingLevel: async () => {} },
		}, { getAvailableSnapshot: () => [], getModel: () => undefined }, parseCliArgs([]), {
			success: (_id, _command, data) => { response = data; },
			error: (_id, _command, message) => { failure = message; },
		});
		assert.equal(failure, undefined);
		assert.deepEqual(response, {
			valid: true,
			durableSessionId: "actual-session-id",
			parentConversationId: ROOT_CONVERSATION_ID,
			childConversationId: childId,
			taskId,
			requestId: `subagent:${taskId}`,
		});
	});

	it("denies mismatched session or ownership, missing child, unrelated tool call, and absent request provenance", async () => {
		assert.deepEqual(await inspectNativeChildIdentity(harness, "other-session", {
			durableSessionId: "actual-session-id", parentConversationId: parentId, childConversationId: childId, taskId,
		}, BACKGROUND_CONTEXT), { valid: false, reason: "not_native_child" });
		const unsubmittedTask = await harness.commit((tx) => tx.createTask(ToolTask, { assistant: assistantId, callId: "call-native-child" }, { ownership: { kind: "conversation" }, conversationId: parentId }), BACKGROUND_CONTEXT);
		const unsubmittedChild = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId: unsubmittedTask } })).id, BACKGROUND_CONTEXT);
		assert.deepEqual(await inspectNativeChildIdentity(harness, "actual-session-id", {
			durableSessionId: "actual-session-id", parentConversationId: parentId, childConversationId: unsubmittedChild, taskId: unsubmittedTask,
		}, BACKGROUND_CONTEXT), { valid: false, reason: "not_native_child" });
		assert.deepEqual(await inspectNativeChildIdentity(harness, "actual-session-id", {
			durableSessionId: "actual-session-id", parentConversationId: parentId, childConversationId: parentId, taskId,
		}, BACKGROUND_CONTEXT), { valid: false, reason: "not_native_child" });
		assert.deepEqual(await inspectNativeChildIdentity(harness, "actual-session-id", {
			durableSessionId: "actual-session-id", parentConversationId: parentId, childConversationId: 999 as ConversationId, taskId,
		}, BACKGROUND_CONTEXT), { valid: false, reason: "not_native_child" });
		const invalidTask = await harness.commit((tx) => tx.createTask(ToolTask, { assistant: assistantId, callId: "other-call" }, { ownership: { kind: "conversation" }, conversationId: parentId }), BACKGROUND_CONTEXT);
		const invalidChild = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId: invalidTask } })).id, BACKGROUND_CONTEXT);
		assert.deepEqual(await inspectNativeChildIdentity(harness, "actual-session-id", {
			durableSessionId: "actual-session-id", parentConversationId: parentId, childConversationId: invalidChild, taskId: invalidTask,
		}, BACKGROUND_CONTEXT), { valid: false, reason: "not_native_child" });
	});

	it("stops a placed child execution task while restored scheduling stays paused, never its parent creator or sibling", async () => {
		const siblingOwner = await harness.commit((tx) => tx.createTask(ToolTask, { assistant: assistantId, callId: "call-native-child" }, { ownership: { kind: "conversation" }, conversationId: parentId }), BACKGROUND_CONTEXT);
		const siblingId = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId: siblingOwner } })).id, BACKGROUND_CONTEXT);
		const sibling = await harness.conversation(siblingId, BACKGROUND_CONTEXT);
		assert.ok(sibling);
		await sibling.submit({ type: "input", content: "sibling", requestId: `subagent:${siblingOwner}` }, BACKGROUND_CONTEXT);
		const childExecutionTaskId = await harness.commit(async (tx) => (await tx.doc(LiveDoc, childId)).run?.taskId, BACKGROUND_CONTEXT);
		const siblingExecutionTaskId = await harness.commit(async (tx) => (await tx.doc(LiveDoc, siblingId)).run?.taskId, BACKGROUND_CONTEXT);
		assert.ok(childExecutionTaskId !== undefined && siblingExecutionTaskId !== undefined);
		assert.notEqual(childExecutionTaskId, taskId, "the parent pi.tool creator is never the child execution task");
		assert.notEqual(siblingExecutionTaskId, childExecutionTaskId);
		const parentBefore = await harness.getTask(taskId, BACKGROUND_CONTEXT);
		const siblingBefore = await harness.getTask(siblingExecutionTaskId, BACKGROUND_CONTEXT);
		const resumesBefore = schedulerResumeCalls;
		let response: unknown;
		let failure: string | undefined;
		const durable = { harness,
			view: { current: () => ({ session: { id: "actual-session-id", directory: "/memory", cwd: "/memory" }, conversation: rootView }) },
			controller: { submit: async () => { throw new Error("stop must not submit"); }, compact: async () => {}, abort: async () => { throw new Error("stop must not abort root"); }, setModel: async () => {}, setThinkingLevel: async () => {} } };
		const responder = { success: (_id: unknown, _command: string, data?: unknown) => { response = data; },
			error: (_id: unknown, _command: string, message: string) => { failure = message; } };
		const request = { type: "native-child-stop", id: "paused-child", durableSessionId: "actual-session-id",
			parentConversationId: parentId, childConversationId: childId, taskId };
		await handleActiveSessionCommand({ ...request, childTaskId: taskId }, durable,
			{ getAvailableSnapshot: () => [], getModel: () => undefined }, parseCliArgs([]), responder, undefined, { executionStarted: false });
		assert.equal(response, undefined);
		assert.ok(failure, "forged caller-provided cancellation target is denied by strict RPC schema");
		failure = undefined;
		await handleActiveSessionCommand(request, durable,
			{ getAvailableSnapshot: () => [], getModel: () => undefined }, parseCliArgs([]), responder, undefined, { executionStarted: false });
		assert.equal(failure, undefined);
		assert.deepEqual(response, { accepted: true, requestId: `subagent:${taskId}`, conversationId: childId, status: "marked" });
		const execution = await harness.getTask(childExecutionTaskId, BACKGROUND_CONTEXT);
		assert.equal(execution?.abortRequested, true, "only the child's actual pi.generation task is marked");
		assert.deepEqual(await harness.getTask(taskId, BACKGROUND_CONTEXT), parentBefore, "parent creator remains intact");
		assert.deepEqual(await harness.getTask(siblingExecutionTaskId, BACKGROUND_CONTEXT), siblingBefore, "sibling execution remains untouched");
		assert.equal(schedulerResumeCalls, resumesBefore, "child stop never globally resumes restored parent or siblings");
	});

	it("withdraws a queued child input while paused without inventing an execution task", async () => {
		const owner = await harness.commit((tx) => tx.createTask(ToolTask, { assistant: assistantId, callId: "call-native-child" }, { ownership: { kind: "conversation" }, conversationId: parentId }), BACKGROUND_CONTEXT);
		const id = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId: owner } })).id, BACKGROUND_CONTEXT);
		await harness.commit(async (tx) => {
			const submission = await tx.createSubmission({ conversationId: id, type: "input", status: "queued", requestId: `subagent:${owner}` });
			(await tx.doc(InboxDoc, id)).items.push({ id: submission.id, mode: "followUp", content: "queued child" });
		}, BACKGROUND_CONTEXT);
		const before = schedulerResumeCalls;
		const parentBefore = await harness.getTask(owner, BACKGROUND_CONTEXT);
		let response: unknown;
		await handleActiveSessionCommand({ type: "native-child-stop", id: "queued", durableSessionId: "actual-session-id", parentConversationId: parentId, childConversationId: id, taskId: owner }, {
			harness, view: { current: () => ({ session: { id: "actual-session-id", directory: "/memory", cwd: "/memory" }, conversation: rootView }) },
			controller: { submit: async () => {}, compact: async () => {}, abort: async () => { throw new Error("stop must not abort root"); }, setModel: async () => {}, setThinkingLevel: async () => {} },
		}, { getAvailableSnapshot: () => [], getModel: () => undefined }, parseCliArgs([]), {
			success: (_id, _command, data) => { response = data; }, error: (_id, _command, error) => { throw new Error(error); },
		}, undefined, { executionStarted: false });
		assert.deepEqual(response, { accepted: true, requestId: `subagent:${owner}`, conversationId: id, status: "withdrawn" });
		assert.equal((await harness.commit((tx) => tx.submissionByRequest(id, `subagent:${owner}`), BACKGROUND_CONTEXT))?.status, "unanswered");
		assert.deepEqual(await harness.getTask(owner, BACKGROUND_CONTEXT), parentBefore);
		assert.equal(schedulerResumeCalls, before);
	});

	it("keeps restored scheduler paused through bootstrap and observation until a real root prompt", async () => {
		const before = schedulerResumeCalls;
		resumeSchedulerOnOpen(harness, { deferResume: true });
		assert.equal(schedulerResumeCalls, before, "retained root startup must not resume restored child tasks");
		const scheduling = { executionStarted: false };
		const results: Array<{ command: string; error?: string }> = [];
		const commands = { harness,
			view: { current: () => ({ session: { id: "actual-session-id", directory: "/memory", cwd: "/memory" }, conversation: rootView }) },
			controller: {
				submit: async (message: string) => { const root = await harness.conversation(parentId, BACKGROUND_CONTEXT); assert.ok(root); await root.submit({ type: "input", content: message }, BACKGROUND_CONTEXT); },
				compact: async () => { throw new Error("bootstrap must not compact"); },
				abort: async () => { throw new Error("bootstrap must not abort"); },
				setModel: async () => undefined, setThinkingLevel: async () => undefined,
			} };
		const respond = { success: (_id: unknown, command: string) => { results.push({ command }); },
			error: (_id: unknown, command: string, error: string) => { results.push({ command, error }); } };
		for (const type of ["get_state", "set_model", "set_thinking_level", "abort", "compact", "native-child-stop"] as const) {
			await handleActiveSessionCommand(type === "native-child-stop"
				? { type, id: type, durableSessionId: "actual-session-id", parentConversationId: parentId, childConversationId: childId, taskId }
				: { type, id: type, provider: "provider", modelId: "model", level: "high" },
				commands, { getAvailableSnapshot: () => [], getModel: () => undefined }, parseCliArgs([]), respond, undefined, scheduling);
			assert.equal(schedulerResumeCalls, before, `${type} must not wake restored native children`);
		}
		assert.deepEqual(results.filter((row) => row.error).map((row) => row.command), ["abort", "compact"], JSON.stringify(results));
		await handleActiveSessionCommand({ type: "prompt", id: "missing" }, commands,
			{ getAvailableSnapshot: () => [], getModel: () => undefined }, parseCliArgs([]), respond, undefined, scheduling);
		assert.equal(schedulerResumeCalls, before, "invalid root prompt must not enable scheduling");
		await handleActiveSessionCommand({ type: "prompt", id: "real", message: "authorized root turn" }, commands,
			{ getAvailableSnapshot: () => [], getModel: () => undefined }, parseCliArgs([]), respond, undefined, scheduling);
		assert.equal(scheduling.executionStarted, true);
		assert.equal(schedulerResumeCalls, before + 1, "native Durable submission alone enables task scheduling");
		resumeSchedulerOnOpen(harness, { deferResume: false });
		assert.equal(schedulerResumeCalls, before + 2, "ordinary legacy startup still resumes scheduler");
	});
});
