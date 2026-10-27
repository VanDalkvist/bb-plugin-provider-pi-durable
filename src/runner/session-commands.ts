import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { OpenDurableResult } from "./runtime-types.ts";
import type { CliArgs } from "./cli-args.ts";
import { handleBindingCommand } from "./binding-commands.ts";
import { handleSessionStateCommand } from "./session-state-commands.ts";
import { subagentPolicyRecordSchema } from "../policy/schema.ts";
import type { CommandResponder, RunnerCommandPayload } from "../contracts/runner-command.ts";
import { parseConversationId } from "./conversation-id.ts";

function toDurableInput(message?: string, images?: import("@earendil-works/pi-ai").ImageContent[]): string | (import("@earendil-works/pi-ai").TextContent | import("@earendil-works/pi-ai").ImageContent)[] | null {
	const msg = message ?? "";
	const imgs = Array.isArray(images) ? images : [];
	if (!msg && imgs.length === 0) return null;
	if (imgs.length === 0) return msg;
	return [...(msg ? [{ type: "text" as const, text: msg }] : []), ...imgs];
}

export async function handleActiveSessionCommand(
	cmd: RunnerCommandPayload,
	durable: OpenDurableResult,
	modelRuntime: ModelRuntime,
	args: CliArgs,
	respond: CommandResponder,
): Promise<void> {
	if (await handleBindingCommand(cmd, durable, respond)) {
		return;
	}
	if (await handleSessionStateCommand(cmd, durable, modelRuntime, args, respond)) {
		return;
	}
	switch (cmd.type) {
		case "prompt": {
			const content = toDurableInput(cmd.message, cmd.images);
			if (!content) {
				respond.error(cmd.id, "prompt", "Missing message or images");
				return;
			}
			respond.success(cmd.id, "prompt");
			const behavior = (cmd.streamingBehavior as "steer" | "followUp") || "followUp";
			const targetId = parseConversationId(cmd.conversationId);
			if (targetId !== ROOT_CONVERSATION_ID) {
				if (durable.watcher) await durable.watcher.ensureAttached(targetId);
				const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT);
				if (!conv) {
					throw new Error(`Conversation not found: ${cmd.conversationId}`);
				}
				await conv.submit({ type: "input", content, whenBusy: behavior }, BACKGROUND_CONTEXT);
			} else {
				await durable.controller.submit(content, behavior);
			}
			break;
		}
		case "steer": {
			const content = toDurableInput(cmd.message, cmd.images);
			if (!content) {
				respond.error(cmd.id, "steer", "Missing message or images");
				return;
			}
			respond.success(cmd.id, "steer");
			const targetId = parseConversationId(cmd.conversationId);
			if (targetId !== ROOT_CONVERSATION_ID) {
				if (durable.watcher) await durable.watcher.ensureAttached(targetId);
				const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT);
				if (!conv) {
					throw new Error(`Conversation not found: ${cmd.conversationId}`);
				}
				await conv.submit({ type: "input", content, whenBusy: "steer" }, BACKGROUND_CONTEXT);
			} else {
				await durable.controller.submit(content, "steer");
			}
			break;
		}
		case "abort": {
			const targetId = parseConversationId(cmd.conversationId);
			if (targetId !== ROOT_CONVERSATION_ID) {
				const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT);
				if (conv) {
					await conv.abort(BACKGROUND_CONTEXT);
				}
			} else {
				await durable.controller.abort();
			}
			respond.success(cmd.id, "abort");
			break;
		}
		case "compact": {
			await durable.controller.compact(cmd.instructions);
			respond.success(cmd.id, "compact");
			break;
		}
		case "set_subagent_policy": {
			try {
				const record = subagentPolicyRecordSchema.parse(cmd.policyRecord);
				await durable.subagentPolicyHolder.setRecord(record);
				respond.success(cmd.id, "set_subagent_policy");
			} catch (err) {
				respond.error(cmd.id, "set_subagent_policy", err instanceof Error ? err.message : String(err));
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
			if (!cmd.level) {
				respond.error(cmd.id, "set_thinking_level", "Missing thinking level");
				return;
			}
			await durable.controller.setThinkingLevel(cmd.level);
			respond.success(cmd.id, "set_thinking_level");
			break;
		}
		default: {
			respond.error(cmd.id, cmd.type ?? "unknown", `Unknown command: ${cmd.type}`);
			break;
		}
	}
}
