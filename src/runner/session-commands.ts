import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { inspectNativeChildIdentity, inspectNativeChildIntent, inspectNativeChildStopTarget, NativeChildIdentityCommandSchema, NativeChildIntentCommandSchema, NativeChildStopCommandSchema } from "./native-child-inspection.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { OpenDurableResult } from "./runtime.ts";
import type { DurableView } from "./runtime-types.ts";
import type { CliArgs } from "./cli-args.ts";
import type { NativeChildDiscoveryObserver } from "./native-child-discovery.ts";

export interface CommandResponder {
	success: (id: string | undefined, command: string, data?: unknown) => void;
	error: (id: string | undefined, command: string, message: string) => void;
}

type SessionCommandDurable = {
	harness: OpenDurableResult["harness"];
	view: { current(): Pick<DurableView, "session" | "conversation"> };
	controller: Pick<OpenDurableResult["controller"], "submit" | "compact" | "abort" | "setModel" | "setThinkingLevel">;
};

type SessionCommandModelRuntime = Pick<ModelRuntime, "getAvailableSnapshot" | "getModel">;

/** Only the retained host's root runner passes this state; read-only commands never unlock restored work. */
export type RetainedRootScheduling = { executionStarted: boolean };

export async function handleActiveSessionCommand(
	cmd: any,
	durable: SessionCommandDurable,
	modelRuntime: SessionCommandModelRuntime,
	args: CliArgs,
	respond: CommandResponder,
	discovery?: NativeChildDiscoveryObserver,
	rootScheduling?: RetainedRootScheduling,
): Promise<void> {
	if (rootScheduling && !rootScheduling.executionStarted
		&& (cmd.type === "abort" || cmd.type === "compact")) {
		respond.error(cmd.id, cmd.type, "Native root has no authorized execution to interrupt");
		return;
	}
	switch (cmd.type) {
		case "prompt": {
			if (!cmd.message) {
				respond.error(cmd.id, "prompt", "Missing message");
				return;
			}
			const behavior = (cmd.streamingBehavior as "steer" | "followUp") || "followUp";
			await durable.controller.submit(cmd.message, behavior);
			if (rootScheduling) rootScheduling.executionStarted = true;
			respond.success(cmd.id, "prompt");
			break;
		}
		case "steer": {
			if (!cmd.message) {
				respond.error(cmd.id, "steer", "Missing message");
				return;
			}
			await durable.controller.submit(cmd.message, "steer");
			if (rootScheduling) rootScheduling.executionStarted = true;
			respond.success(cmd.id, "steer");
			break;
		}
		case "abort": {
			await durable.controller.abort();
			respond.success(cmd.id, "abort");
			break;
		}
		case "compact": {
			await durable.controller.compact(cmd.instructions);
			respond.success(cmd.id, "compact");
			break;
		}
		case "get_state": {
			const current = durable.view.current();
			const agentDoc = (current.conversation.docs["pi.agent"] ?? {}) as any;
			const modelObj = agentDoc.model
				? {
						provider: agentDoc.model.provider,
						id: agentDoc.model.id ?? agentDoc.model.modelId,
						modelId: agentDoc.model.modelId ?? agentDoc.model.id,
					}
				: null;
			respond.success(cmd.id, "get_state", {
				model: modelObj,
				thinkingLevel: agentDoc.thinkingLevel ?? "none",
				cwd: args.cwd ?? process.cwd(),
				sessionId: args.session ?? "default",
				durableSessionId: current.session.id,
				conversationId: current.conversation.conversation.id,
			});
			break;
		}
		case "native-child-discover": {
			const current = durable.view.current();
			if (!discovery || cmd.durableSessionId !== current.session.id || cmd.parentConversationId !== ROOT_CONVERSATION_ID) {
				respond.error(cmd.id, cmd.type, "Native child discovery denied");
				return;
			}
			respond.success(cmd.id, cmd.type, await discovery.reconcile());
			break;
		}
		case "native-child-stop":
		case "native-child-intent":
		case "native-child-identity": {
			const command = cmd.type === "native-child-stop" ? "native-child-stop" : cmd.type === "native-child-intent" ? "native-child-intent" : "native-child-identity";
			const schema = command === "native-child-stop" ? NativeChildStopCommandSchema : command === "native-child-intent" ? NativeChildIntentCommandSchema : NativeChildIdentityCommandSchema;
			const request = schema.safeParse(cmd);
			const current = durable.view.current();
			if (!request.success
				|| request.data.durableSessionId !== current.session.id
				|| request.data.parentConversationId !== ROOT_CONVERSATION_ID) {
				respond.error(cmd.id, command, "Native child identity denied");
				return;
			}
			const inspect = command === "native-child-intent" ? inspectNativeChildIntent : inspectNativeChildIdentity;
			const result = await inspect(durable.harness, current.session.id, {
				durableSessionId: request.data.durableSessionId,
				parentConversationId: request.data.parentConversationId as ConversationId,
				childConversationId: request.data.childConversationId as ConversationId,
				taskId: request.data.taskId as TaskId,
			}, BACKGROUND_CONTEXT);
			if (!result.valid) {
				respond.error(cmd.id, command, "Native child identity denied");
				return;
			}
			if (command === "native-child-stop") {
				if (rootScheduling && !rootScheduling.executionStarted) {
					const target = await inspectNativeChildStopTarget(durable.harness, current.session.id, result.proof, BACKGROUND_CONTEXT);
					if (!target) {
						respond.error(cmd.id, command, "Native child execution target denied");
						return;
					}
					let status: "marked" | "terminal" | "withdrawn";
					if (target.kind === "task") {
						status = await durable.harness.abortTask(target.taskId, BACKGROUND_CONTEXT);
					} else if (target.kind === "queued") {
						const withdrawn = await durable.harness.abortSubmission(target.submissionId, BACKGROUND_CONTEXT, result.proof.childConversationId);
						if (withdrawn !== "aborted") {
							respond.error(cmd.id, command, "Native child submission changed before stop");
							return;
						}
						status = "withdrawn";
					} else {
						status = "terminal";
					}
					respond.success(cmd.id, command, { accepted: true, requestId: result.proof.requestId, conversationId: result.proof.childConversationId, status });
					break;
				}
				const child = await durable.harness.conversation(result.proof.childConversationId, BACKGROUND_CONTEXT);
				if (!child) {
					respond.error(cmd.id, command, "Native child identity denied");
					return;
				}
				await child.abort(BACKGROUND_CONTEXT, { background: true });
				respond.success(cmd.id, command, { accepted: true, requestId: result.proof.requestId, conversationId: result.proof.childConversationId });
			} else {
				respond.success(cmd.id, command, result.proof);
			}
			break;
		}
		case "get_available_models": {
			const currentModels = modelRuntime.getAvailableSnapshot();
			respond.success(cmd.id, "get_available_models", { models: currentModels });
			break;
		}
		case "set_model": {
			if (!cmd.provider || !cmd.modelId) {
				respond.error(cmd.id, "set_model", "Missing provider or modelId");
				return;
			}
			await durable.controller.setModel({ provider: cmd.provider, modelId: cmd.modelId });
			respond.success(cmd.id, "set_model");
			break;
		}
		case "set_thinking_level": {
			await durable.controller.setThinkingLevel(cmd.level);
			respond.success(cmd.id, "set_thinking_level");
			break;
		}
		case "get_session_stats": {
			const current = durable.view.current();
			const agentDoc = (current.conversation.docs["pi.agent"] ?? {}) as any;
			let contextWindow = 128000;
			const provider = agentDoc.model?.provider ?? args.provider;
			const modelId = agentDoc.model?.modelId ?? args.model;
			if (provider && modelId) {
				const m = modelRuntime.getModel(provider, modelId);
				if (m?.contextWindow) contextWindow = m.contextWindow;
			}
			let tokens: number | null = null;
			try {
				const conv = await durable.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
				if (conv) {
					const ctxView = await conv.context(BACKGROUND_CONTEXT);
					const estimate = estimateContextTokens(ctxView.messages);
					tokens = estimate.tokens;
				}
			} catch (err) {
				console.error(`Error estimating context tokens: ${err}`);
			}
			respond.success(cmd.id, "get_session_stats", {
				contextUsage: {
					tokens,
					contextWindow,
				},
			});
			break;
		}
		default: {
			respond.error(cmd.id, cmd.type, `Unknown command: ${cmd.type}`);
			break;
		}
	}
}
