import type { JsonValue } from "@earendil-works/chord";
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
import { buildTechnicalWorkerRole } from "./subagent-role.ts";
import { resolveSubagentModelConfiguration } from "../policy/resolver.ts";
import type { SubagentPolicyRecord } from "../policy/types.ts";

export function createSubagentExtension(
	getPolicy: () => SubagentPolicyRecord,
): Extension {
	return defineExtension({
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

					const existingRecord = await api.commit(async (tx) => {
						const state = await tx.doc(SubagentsDoc, api.conversationId);
						return state?.agents?.[key];
					}, context);

					let childRecord: SubagentRecord;

					if (existingRecord) {
						childRecord = existingRecord;
					} else {
						const parentAgent = await api.agent(context);
						const policySnapshot = getPolicy();
						const availableModels =
							policySnapshot.policy.mode === "configured"
								? await api.models.getAvailable()
								: [];

						const resolved = resolveSubagentModelConfiguration(
							policySnapshot,
							{
								model: parentAgent.model
									? { provider: parentAgent.model.provider, modelId: parentAgent.model.modelId }
									: undefined,
								thinkingLevel: parentAgent.thinkingLevel,
							},
							availableModels,
						);

						childRecord = await api.commit(async (tx) => {
							const state = await tx.doc(SubagentsDoc, api.conversationId);
							if (state?.agents?.[key]) {
								return state.agents[key];
							}

							const existingConv = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
							let childId = existingConv?.id;
							if (childId === undefined) {
								const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
								await configure(tx, created.id, {
									model: resolved.model,
									thinkingLevel: resolved.thinkingLevel,
									instructions: buildTechnicalWorkerRole(),
								});
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
								actualModel: resolved.model,
								thinkingLevel: resolved.thinkingLevel,
								source: resolved.source,
								policyRevision: resolved.policyRevision,
							};

							if (isBackground) {
								record.reporter = await tx.createTask(
									DefaultReporter,
									{ key, conversationId: childId, task: args.task, requestId },
									BACKGROUND,
								);
							}

							if (state) {
								state.agents ??= {};
								state.agents[key] = record;
							}

							return record;
						}, context);
					}

					const detailsPayload: Record<string, JsonValue> = {
						conversationId: childRecord.conversationId,
						task: args.task,
						background: isBackground,
					};
					if (childRecord.actualModel) {
						detailsPayload.actualModel = childRecord.actualModel;
					}
					if (childRecord.thinkingLevel) {
						detailsPayload.thinkingLevel = childRecord.thinkingLevel;
					}
					if (childRecord.source) {
						detailsPayload.source = childRecord.source;
					}
					if (childRecord.policyRevision !== undefined) {
						detailsPayload.policyRevision = childRecord.policyRevision;
					}

					await api.details(detailsPayload, context);

					if (isBackground) {
						return {
							output: [
								{
									type: "text",
									text: `Subagent spawned in background (conversation ${childRecord.conversationId}). The task is running independently and will report upon completion.`,
								},
							],
							details: detailsPayload,
						};
					}

					const handle = await api.conversation(childRecord.conversationId, context);
					if (!handle) throw new Error(`Failed to access subagent conversation: ${childRecord.conversationId}`);
					const submission = await handle.submit({ type: "input", content: args.task, requestId }, context);

					const settled = await submission.wait(context);
					if (settled.status !== "done" || settled.type !== "input") {
						throw new Error(`Subagent ${childRecord.conversationId} failed: ${settled.status}`);
					}
					const text = await answerText(api, settled.answer, context);
					await api.commit(async (tx) => {
						const state = await tx.doc(SubagentsDoc, api.conversationId);
						if (state?.agents?.[key]) {
							state.agents[key].settled = true;
							state.agents[key].report = text;
						}
					}, context);
					return {
						output: [{ type: "text", text }],
						details: detailsPayload,
					};
				},
			}),
		],
	});
}
