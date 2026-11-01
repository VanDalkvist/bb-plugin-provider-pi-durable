import {
	AssistantEntry, defineTask, type Extension,
} from "@earendil-works/pi-durable";
import { SubagentsDoc, extractAssistantText } from "./subagent-docs.ts";
import { nativeChildTitle } from "../shared/child-title.ts";
import type {
	CourierTask, ReporterInput, ReporterState,
	SubagentAdmission, SubagentTaskExtension,
} from "./subagent-delivery-types.ts";
import { asExtensionTask, courierFor, courierIsIdle } from "./subagent-courier.ts";

export type * from "./subagent-delivery-types.ts";
export { answerText } from "./subagent-docs.ts";
export { courierFor, courierIsIdle } from "./subagent-courier.ts";

export const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

export const Anchor = asExtensionTask(
	defineTask<null, { phase: "done" }, null>({
		name: "durable.subagent-anchor", version: 1, initial: () => ({ phase: "done" }),
		phases: { done: (_t, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx) },
		abort: (_t, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	}),
	"durable.subagent-anchor",
);

export function reporterFor(courier: CourierTask, admit?: SubagentAdmission): SubagentTaskExtension<ReporterInput, ReporterState, null> {
	const task = defineTask<ReporterInput, ReporterState, null>({
		name: "durable.subagent-reporter", version: 1,
		initial: () => ({ phase: "deliver" }),
		phases: {
			deliver: async (task, runtime, context) => {
				const child = (await runtime.conversation(task.input.conversationId, context))!;
				await admit?.(child, task.input.requestId, context);
				const submission = await child.submit({ type: "input", content: task.input.task, requestId: task.input.requestId }, context);
				const settled = await submission.wait(context);
				return runtime.commit(async (tx) => {
					const doc = await tx.doc(SubagentsDoc, runtime.conversationId);
					doc.agents ??= {};
					const record = doc.agents[task.input.key] ?? {
						name: nativeChildTitle(task.input.task, "worker"), conversationId: task.input.conversationId, requestId: task.input.requestId,
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
			report: async (task, runtime, context) => runtime.commit(async (tx) => {
				const state = await tx.doc(SubagentsDoc, runtime.conversationId);
				const reportId = String(task.id);
				if (!(state.outbox ?? []).some((report) => report.id === reportId)) {
					const name = state.agents[task.input.key]?.name ?? task.input.key;
					state.outbox = [...(state.outbox ?? []), { id: reportId, name, text: task.state.checkpoint.text }];
				}
				const active = state.courier === undefined ? undefined : await tx.task(state.courier);
				if (courierIsIdle(active)) state.courier = await tx.createTask(courier, null, BACKGROUND);
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context),
		},
		abort: (_t, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	return asExtensionTask(task, "durable.subagent-reporter");
}

export const DefaultCourier = courierFor();
export const DefaultReporter = reporterFor(DefaultCourier);

export const SubagentTasksExtension: Extension = {
	name: "durable.subagent-tasks",
	tasks: [Anchor, DefaultCourier, DefaultReporter],
};
