import type { Context } from "@earendil-works/chord";
import {
	AssistantEntry, defineTask, type ConversationHandle, type ConversationId,
	type Extension, type Task,
} from "@earendil-works/pi-durable";
import { SubagentsDoc, extractAssistantText } from "./subagent-docs.ts";
export { answerText } from "./subagent-docs.ts";

export const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;
const GATHER_MS = 50;

export type SubagentAdmission = (child: ConversationHandle, requestId: string, context: Context) => Promise<void>;
export type Admission = (conversation: ConversationHandle, requestId: string, context: Context) => Promise<void>;
export type ReporterInput = { key: string; conversationId: ConversationId; task: string; requestId: string };
export type ReporterState = { phase: "deliver" } | { phase: "report"; text: string };
export type CourierState = { phase: "gather" | "next" | "send" | "hold" };

export type CourierTask = Task<null, CourierState, null, object>;
export type ReporterTask = Task<ReporterInput, ReporterState, null, object>;
export type SubagentTaskExtension<I, S extends { phase: string }, R, H extends object = object> = Task<I, S, R, H> & Extension;

function asExtensionTask<I, S extends { phase: string }, R, H extends object = object>(
	task: Task<I, S, R, H>, extensionName: string,
): SubagentTaskExtension<I, S, R, H> {
	return Object.assign(task, { name: extensionName, tasks: [task] });
}

export const Anchor = asExtensionTask(
	defineTask<null, { phase: "done" }, null>({
		name: "bb.subagent-anchor", version: 1, initial: () => ({ phase: "done" }),
		phases: { done: (_t, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx) },
		abort: (_t, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	}),
	"bb.subagent-anchor",
);

export function reporterFor(courier: CourierTask, admit?: SubagentAdmission): SubagentTaskExtension<ReporterInput, ReporterState, null> {
	const task = defineTask<ReporterInput, ReporterState, null>({
		name: "bb.subagent-reporter", version: 1,
		initial: () => ({ phase: "deliver" }),
		phases: {
			deliver: async (task, runtime, context) => {
				const child = (await runtime.conversation(task.input.conversationId, context))!;
				await admit?.(child, task.input.requestId, context);
				const submission = await child.submit(
					{ type: "input", content: task.input.task, requestId: task.input.requestId }, context);
				const settled = await submission.wait(context);
				return runtime.commit(async (tx) => {
					const doc = await tx.doc(SubagentsDoc, runtime.conversationId);
					doc.agents ??= {};
					const record = doc.agents[task.input.key] ?? {
						name: task.input.key, conversationId: task.input.conversationId, requestId: task.input.requestId,
						task: task.input.task, role: "worker", ownerTaskId: task.id, background: true,
					};
					doc.agents[task.input.key] = record;
					let text = `Subagent ${record.name} failed: ${settled.status}`;
					if (settled.status === "unanswered") text += ` (${settled.reason ?? "unknown"})`;
					if (settled.status === "done" && settled.type === "input") {
						text = `Subagent ${record.name} answered: ` + extractAssistantText(await tx.entry(AssistantEntry, settled.answer));
					}
					record.report = text;
					record.settled = true;
					return { status: "running", checkpoint: { phase: "report", text } };
				}, context);
			},
			report: async (task, runtime, context) =>
				runtime.commit(async (tx) => {
					const state = await tx.doc(SubagentsDoc, runtime.conversationId);
					const reportId = String(task.id);
					if (!(state.outbox ?? []).some((report) => report.id === reportId)) {
						const name = state.agents[task.input.key]?.name ?? task.input.key;
						state.outbox = [...(state.outbox ?? []), { id: reportId, name, text: task.state.checkpoint.text }];
					}
					const active = state.courier === undefined ? undefined : await tx.task(state.courier);
					const isIdle = !active || (active.state.status !== "pending" && active.state.status !== "running" && active.state.status !== "waiting");
					if (isIdle) state.courier = await tx.createTask(courier, null, BACKGROUND);
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context),
		},
		abort: (_t, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	return asExtensionTask(task, "bb.subagent-reporter");
}

export function courierFor(admit?: Admission): SubagentTaskExtension<null, CourierState, null> {
	const task = defineTask<null, CourierState, null>({
		name: "bb.subagent-courier", version: 1,
		initial: () => ({ phase: "gather" }),
		phases: {
			gather: async (_task, runtime, context) => {
				await runtime.sleep(runtime.now() + GATHER_MS, context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
			},
			next: async (task, runtime, context) => runtime.commit(async (tx) => {
				const state = await tx.doc(SubagentsDoc, runtime.conversationId);
				if (state.deliveryHold !== undefined) return { status: "running", checkpoint: { phase: "hold" } };
				if (state.sending === undefined) {
					const reports = state.outbox ?? [];
					if (reports.length === 0) {
						if (state.courier === task.id) delete state.courier;
						return { status: "terminal", outcome: { status: "completed", result: null } };
					}
					const batch = (state.batchNumber ?? 0) + 1;
					state.batchNumber = batch;
					state.outbox = [];
					state.sending = { requestId: `subagent-batch:${task.id}:${batch}`, reports };
				}
				return { status: "running", checkpoint: { phase: "send" } };
			}, context),
			send: async (_task, runtime, context) => {
				const state = await runtime.snapshot(SubagentsDoc, runtime.conversationId, context);
				const sending = state?.sending;
				if (sending === undefined) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
					return;
				}
				const parent = (await runtime.conversation(runtime.conversationId, context))!;
				try {
					await admit?.(parent, sending.requestId, context);
				} catch (error) {
					if (runtime.signal.aborted || context.abortSignal?.aborted) throw error;
					const reason = error instanceof Error ? error.message : String(error);
					await runtime.commit(async (tx) => {
						const current = await tx.doc(SubagentsDoc, runtime.conversationId);
						if (current.sending?.requestId === sending.requestId) {
							current.deliveryHold = { kind: "admission", requestId: sending.requestId, reason };
						}
						return { status: "running", checkpoint: { phase: "hold" } };
					}, context);
					return;
				}
				const submission = await parent.submit({
					type: "input", content: sending.reports.map((r) => r.text).join("\n\n"),
					whenBusy: "followUp", requestId: sending.requestId,
				}, context);
				const settled = await submission.wait(context);
				await runtime.commit(async (tx) => {
					const current = await tx.doc(SubagentsDoc, runtime.conversationId);
					if (current.sending?.requestId !== sending.requestId) return { status: "running", checkpoint: { phase: "next" } };
					if (settled.status === "done") delete current.sending;
					else current.deliveryHold = { kind: "uncertain", requestId: sending.requestId, reason: `Delivery outcome uncertain: ${settled.status}` };
					return { status: "running", checkpoint: { phase: settled.status === "done" ? "next" : "hold" } };
				}, context);
			},
			hold: async (_task, runtime, context) => {
				const watch = await runtime.watchDoc(SubagentsDoc, runtime.conversationId, context);
				if (watch === undefined || watch.value?.deliveryHold === undefined) {
					await watch?.stop();
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
					return;
				}
				try {
					await new Promise<void>((resolve, reject) => {
						watch.start((v) => { if (v?.deliveryHold === undefined) resolve(); return Promise.resolve(); });
						void watch.closed.then(() => reject(new Error("Courier hold watch ended")));
					});
				} finally {
					await watch.stop();
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
			},
		},
		abort: (_t, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	return asExtensionTask(task, "bb.subagent-courier");
}

export const DefaultCourier = courierFor();
export const DefaultReporter = reporterFor(DefaultCourier);

export const SubagentTasksExtension: Extension = {
	name: "bb.subagent-tasks",
	tasks: [Anchor, DefaultCourier, DefaultReporter],
};

