import { defineTask, type Task, type TaskRecord } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "./subagent-docs.ts";
import type { Admission, CourierState, SubagentTaskExtension } from "./subagent-delivery-types.ts";

export const GATHER_MS = 50;
export const DEFAULT_HOLD_TIMEOUT_MS = 5000;

type CourierLiveness = { state: Pick<TaskRecord<null, { phase: string }, null>["state"], "status"> };
export function courierIsIdle(active: CourierLiveness | undefined): boolean {
	return active === undefined || active.state.status === "terminal";
}

export function clearDeliveryHold(doc: { deliveryHold?: unknown }): void {
	delete doc.deliveryHold;
}

export function asExtensionTask<I, S extends { phase: string }, R, H extends object = object>(
	task: Task<I, S, R, H>, extensionName: string,
): SubagentTaskExtension<I, S, R, H> {
	return Object.assign(task, { name: extensionName, tasks: [task] });
}

export function courierFor(admit?: Admission, holdTimeoutMs = DEFAULT_HOLD_TIMEOUT_MS): SubagentTaskExtension<null, CourierState, null> {
	const task = defineTask<null, CourierState, null>({
		name: "durable.subagent-courier", version: 1,
		initial: () => ({ phase: "gather" }),
		phases: {
			gather: (_task, runtime, context) => runtime.sleepUntil(runtime.now() + GATHER_MS, { phase: "next" }, context),
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
				const prompt = sending.reports.map((r) => r.text).join("\n\n---\n\n");
				const content = `[Subagent Reports Available]:\n\n${prompt}`;
				const submission = await parent.submit({ type: "input", content, whenBusy: "followUp", requestId: sending.requestId }, context);
				const settled = await submission.wait(context);
				return runtime.commit(async (tx) => {
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
					return runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
				}
				try {
					await new Promise<void>((resolve) => {
						const timer = setTimeout(() => resolve(), holdTimeoutMs);
						timer.unref?.();
						watch.start((v) => {
							if (v?.deliveryHold === undefined) {
								clearTimeout(timer);
								resolve();
							}
							return Promise.resolve();
						});
						void watch.closed.then(() => {
							clearTimeout(timer);
							resolve();
						});
					});
				} finally {
					await watch.stop();
				}
				return runtime.commit(async (tx) => {
					const current = await tx.doc(SubagentsDoc, runtime.conversationId);
					delete current.deliveryHold;
					return { status: "running", checkpoint: { phase: "next" } };
				}, context);
			},
		},
		abort: (_t, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	return asExtensionTask(task, "durable.subagent-courier");
}
