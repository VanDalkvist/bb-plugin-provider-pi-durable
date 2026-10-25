import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { OpenDurableResult } from "./runtime-types.ts";
import type { CliArgs } from "./cli-args.ts";
import type { CommandResponder, RunnerCommandPayload } from "../contracts/runner-command.ts";
import { parseConversationId } from "./conversation-id.ts";

interface SessionAgentDoc {
	model?: { provider?: string; id?: string; modelId?: string };
	thinkingLevel?: import("@earendil-works/pi-ai").ModelThinkingLevel;
}

export async function handleSessionStateCommand(
	cmd: RunnerCommandPayload,
	durable: OpenDurableResult,
	modelRuntime: ModelRuntime,
	args: CliArgs,
	respond: CommandResponder,
): Promise<boolean> {
	if (cmd.type === "get_state") {
		const targetId = parseConversationId(cmd.conversationId);
		let agentDoc: SessionAgentDoc;

		if (targetId !== ROOT_CONVERSATION_ID) {
			const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT);
			if (!conv) {
				throw new Error(`Conversation not found: ${cmd.conversationId}`);
			}
			const agentState = await conv.agent(BACKGROUND_CONTEXT);
			agentDoc = agentState as SessionAgentDoc;
		} else {
			const current = durable.view.current();
			agentDoc = (current.conversation.docs["pi.agent"] ?? {}) as SessionAgentDoc;
		}

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
		});
		return true;
	}

	if (cmd.type === "get_session_stats") {
		const targetId = parseConversationId(cmd.conversationId);
		let agentDoc: SessionAgentDoc;

		if (targetId !== ROOT_CONVERSATION_ID) {
			const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT);
			const agentState = conv ? await conv.agent(BACKGROUND_CONTEXT) : undefined;
			agentDoc = (agentState ?? {}) as SessionAgentDoc;
		} else {
			const current = durable.view.current();
			agentDoc = (current.conversation.docs["pi.agent"] ?? {}) as SessionAgentDoc;
		}

		let contextWindow = 128000;
		const provider = agentDoc.model?.provider ?? args.provider;
		const modelId = agentDoc.model?.modelId ?? args.model;
		if (provider && modelId) {
			const m = modelRuntime.getModel(provider, modelId);
			if (m?.contextWindow) contextWindow = m.contextWindow;
		}

		let tokens: number | null = null;
		try {
			const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT);
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
		return true;
	}

	return false;
}
