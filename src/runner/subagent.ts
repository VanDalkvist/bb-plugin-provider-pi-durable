import { Type } from "@earendil-works/pi-ai";
import {
	configure,
	defineExtension,
	defineTool,
	type Extension,
} from "@earendil-works/pi-durable";
import { SubagentsDoc, type SubagentRecord } from "./subagent-docs.ts";
import { BACKGROUND, DefaultReporter, answerText } from "./subagent-delivery.ts";
import { nativeChildTitle } from "./child-title.ts";

export function buildRoleEnvelope(task: string): string {
	return [
		"You are an isolated worker subagent.",
		`Your ONLY goal is to solve the delegated task: "${task}".`,
		"Rules:",
		"- Focus strictly on solving the assigned task using your available tools.",
		"- Do not attempt repository-wide meta-discovery, git archaeology, or searching for other agents.",
		"- Execute the task and return your final answer concisely.",
	].join("\n");
}

export const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description:
				"Delegate a self-contained task to an async subagent. Runs in the background by default without blocking the conversation.",
			parameters: Type.Object({
				task: Type.String({ description: "What the subagent should do" }),
				background: Type.Optional(
					Type.Boolean({
						description:
							"Run in background asynchronously (default: true). Set false only if an immediate synchronous answer is strictly required.",
						default: true,
					}),
				),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				const isBackground = args.background !== false;
				const key = `subagent:${api.taskId}`;
				const requestId = `subagent:${api.taskId}`;

				const child = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					let childId = existing?.id;
					if (childId === undefined) {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { instructions: buildRoleEnvelope(args.task) });
						childId = created.id;
					}

					const record: SubagentRecord = {
						name: nativeChildTitle(args.task, "worker"),
						conversationId: childId,
						requestId,
						task: args.task,
						role: "worker",
						ownerTaskId: api.taskId,
						background: isBackground,
					};

					if (isBackground && typeof tx.createTask === "function") {
						record.reporter = await tx.createTask(
							DefaultReporter,
							{ key, conversationId: childId, task: args.task, requestId },
							BACKGROUND,
						);
					}

					const state = await tx.doc(SubagentsDoc, api.conversationId);
					if (state) {
						state.agents ??= {};
						state.agents[key] = record;
					}

					return childId;
				}, context);

				await api.details({ conversationId: child, task: args.task, background: isBackground }, context);

				if (isBackground) {
					return {
						output: [
							{
								type: "text",
								text: `Subagent spawned in background (conversation ${child}). The task is running independently and will report upon completion.`,
							},
						],
						details: { conversationId: child, background: true, task: args.task },
					};
				}

				const handle = await api.conversation(child, context);
				if (!handle) throw new Error(`Failed to access subagent conversation: ${child}`);
				const submission = await handle.submit({ type: "input", content: args.task, requestId }, context);

				const settled = await submission.wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`Subagent ${child} failed: ${settled.status}`);
				}
				const text = await answerText(api, settled.answer, context);
				await api.commit(async (tx) => {
					const state = await tx.doc(SubagentsDoc, api.conversationId);
					if (state?.agents?.[key]) {
						state.agents[key].settled = true;
						state.agents[key].report = text;
					}
				}, context);
				return { output: [{ type: "text", text }], details: { conversationId: child, background: false, task: args.task } };
			},
		}),
	],
});
