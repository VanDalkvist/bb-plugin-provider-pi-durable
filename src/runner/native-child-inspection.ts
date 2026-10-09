import type { Context } from "@earendil-works/chord";
import { AssistantEntry, LiveDoc } from "@earendil-works/pi-durable";
import type { ConversationId, EntryId, Harness, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { z } from "zod";

export const NativeChildIdentityRequestSchema = z.object({
	durableSessionId: z.string().min(1).max(512),
	parentConversationId: z.number().int().safe().nonnegative(),
	childConversationId: z.number().int().safe().nonnegative(),
	taskId: z.number().int().safe().nonnegative(),
}).strict();

export const NativeChildIdentityCommandSchema = NativeChildIdentityRequestSchema.extend({
	type: z.literal("native-child-identity"),
	id: z.string().min(1).max(128).optional(),
}).strict();

export const NativeChildIntentCommandSchema = NativeChildIdentityRequestSchema.extend({
	type: z.literal("native-child-intent"),
	id: z.string().min(1).max(128).optional(),
}).strict();

export const NativeChildStopCommandSchema = NativeChildIdentityRequestSchema.extend({
	type: z.literal("native-child-stop"),
	id: z.string().min(1).max(128).optional(),
}).strict();

export const NativeChildIntentProofSchema = NativeChildIdentityRequestSchema.extend({
	valid: z.literal(true),
	phase: z.literal("intent"),
	requestId: z.string().min(1).max(512),
}).strict().refine((proof) => proof.requestId === `subagent:${proof.taskId}`);

export type NativeChildIdentityRequest = {
	durableSessionId: string;
	parentConversationId: ConversationId;
	childConversationId: ConversationId;
	taskId: TaskId;
};

export type NativeChildIdentityProof = {
	valid: true;
	durableSessionId: string;
	parentConversationId: ConversationId;
	childConversationId: ConversationId;
	taskId: TaskId;
	requestId: string;
};

export type NativeChildIdentityInspection =
	| { valid: true; proof: NativeChildIdentityProof }
	| { valid: false; reason: "not_native_child" };

export type NativeChildIntentInspection =
	| { valid: true; proof: NativeChildIdentityProof & { phase: "intent" } }
	| { valid: false; reason: "not_native_child" };

export type NativeChildStopTarget =
	| { kind: "queued"; submissionId: SubmissionId }
	| { kind: "task"; taskId: TaskId }
	| { kind: "terminal" };

function taskCall(input: unknown): { assistant: number; callId: string } | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const value = input as Record<string, unknown>;
	const assistant = value.assistant;
	const assistantId = typeof assistant === "number"
		? assistant
		: typeof assistant === "object" && assistant !== null && "id" in assistant ? assistant.id : undefined;
	if (!Number.isSafeInteger(assistantId) || typeof value.callId !== "string" || value.callId.length === 0) return undefined;
	return { assistant: assistantId as number, callId: value.callId };
}

export async function inspectNativeChildIntent(
	harness: Harness,
	durableSessionId: string,
	request: NativeChildIdentityRequest,
	context: Context,
): Promise<NativeChildIntentInspection> {
	if (!durableSessionId || request.durableSessionId !== durableSessionId) return { valid: false, reason: "not_native_child" };
	const child = await harness.commit((tx) => tx.conversation(request.childConversationId), context);
	if (!child?.owner || child.owner.conversationId !== request.parentConversationId || child.owner.taskId !== request.taskId) {
		return { valid: false, reason: "not_native_child" };
	}
	const task = await harness.getTask(request.taskId, context);
	if (!task || task.kind !== "pi.tool" || task.conversationId !== request.parentConversationId) {
		return { valid: false, reason: "not_native_child" };
	}
	const call = taskCall(task.input);
	if (!call) return { valid: false, reason: "not_native_child" };
	const assistant = await harness.commit((tx) => tx.entry(AssistantEntry, call.assistant as EntryId), context);
	const toolCall = assistant?.model?.[0];
	if (toolCall?.role !== "assistant"
		|| !toolCall.content.some((part) => part.type === "toolCall" && part.id === call.callId && part.name === "subagent")) {
		return { valid: false, reason: "not_native_child" };
	}
	const requestId = `subagent:${request.taskId}`;
	return {
		valid: true,
		proof: {
			phase: "intent",
			valid: true,
			durableSessionId,
			parentConversationId: request.parentConversationId,
			childConversationId: request.childConversationId,
			taskId: request.taskId,
			requestId,
		},
	};
}

export async function inspectNativeChildIdentity(
	harness: Harness,
	durableSessionId: string,
	request: NativeChildIdentityRequest,
	context: Context,
): Promise<NativeChildIdentityInspection> {
	const intent = await inspectNativeChildIntent(harness, durableSessionId, request, context);
	if (!intent.valid) return intent;
	const submission = await harness.commit((tx) => tx.submissionByRequest(request.childConversationId, intent.proof.requestId), context);
	if (!submission || submission.conversationId !== request.childConversationId || submission.type !== "input") {
		return { valid: false, reason: "not_native_child" };
	}
	const { phase: _phase, ...proof } = intent.proof;
	return { valid: true, proof };
}

/** Reprove the native link atomically; a creator pi.tool task is NEVER a child cancellation target. */
export async function inspectNativeChildStopTarget(
	harness: Harness,
	durableSessionId: string,
	proof: NativeChildIdentityProof,
	context: Context,
): Promise<NativeChildStopTarget | undefined> {
	if (!durableSessionId || proof.durableSessionId !== durableSessionId || proof.requestId !== `subagent:${proof.taskId}`) return undefined;
	return harness.commit(async (tx) => {
		const child = await tx.conversation(proof.childConversationId);
		if (!child?.owner || child.owner.conversationId !== proof.parentConversationId || child.owner.taskId !== proof.taskId) return undefined;
		const creator = await tx.task(proof.taskId);
		if (!creator || creator.kind !== "pi.tool" || creator.conversationId !== proof.parentConversationId) return undefined;
		const call = taskCall(creator.input);
		if (!call) return undefined;
		const assistant = await tx.entry(AssistantEntry, call.assistant as EntryId);
		const toolCall = assistant?.model?.[0];
		if (toolCall?.role !== "assistant"
			|| !toolCall.content.some((part) => part.type === "toolCall" && part.id === call.callId && part.name === "subagent")) return undefined;
		const submission = await tx.submissionByRequest(proof.childConversationId, proof.requestId);
		if (!submission || submission.conversationId !== proof.childConversationId || submission.type !== "input") return undefined;
		if (submission.status === "queued") return { kind: "queued", submissionId: submission.id };
		if (submission.status === "done" || submission.status === "unanswered") return { kind: "terminal" };
		// A placed submission can be stopped only through its actual CHILD run's task.
		const live = await tx.doc(LiveDoc, proof.childConversationId);
		if (!live.run?.inputs.includes(submission.id)) return undefined;
		const execution = await tx.task(live.run.taskId);
		if (!execution || execution.id === proof.taskId || execution.kind !== "pi.generation"
			|| execution.conversationId !== proof.childConversationId || execution.owner !== undefined) return undefined;
		return { kind: "task", taskId: execution.id };
	}, context);
}
