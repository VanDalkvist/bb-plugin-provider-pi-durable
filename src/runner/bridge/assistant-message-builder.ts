import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { DurableView } from "../runtime.ts";
import {
	isUsageDocument,
	isConversationEntryRecord,
	type BBAssistantMessage,
	type BBAssistantMessageUsage,
	type ConversationEntryRecord,
	type UsageDocument,
} from "./contracts.ts";

/**
 * Reconstructs or extracts the final assistant message and usage metrics for turn completion.
 * AP-026, AP-029 compliant.
 */
export function buildFinalAssistantMessage(
	current: DurableView,
	lastGenerationText: string,
	lastThinkingText: string,
): BBAssistantMessage {
	const entries = current.conversation.entries ?? [];
	const lastAssistantEntry = [...entries].reverse().find(
		(e): e is ConversationEntryRecord => isConversationEntryRecord(e) && e.kind === "pi.assistant",
	);
	const lastAssistantMsg = lastAssistantEntry?.model?.[0] as AssistantMessage | undefined;

	if (lastAssistantMsg) {
		const content = Array.isArray(lastAssistantMsg.content)
			? (lastAssistantMsg.content as unknown as BBAssistantMessage["content"])
			: [{ type: "text" as const, text: lastGenerationText }];
		const stopReason = typeof lastAssistantMsg.stopReason === "string"
			? (lastAssistantMsg.stopReason as BBAssistantMessage["stopReason"])
			: "stop";
		const usage = (typeof lastAssistantMsg.usage === "object" && lastAssistantMsg.usage !== null)
			? (lastAssistantMsg.usage as BBAssistantMessageUsage)
			: undefined;

		return {
			role: "assistant",
			content,
			stopReason,
			usage,
		};
	}

	const finalContent: BBAssistantMessage["content"] = [];
	if (lastThinkingText) {
		finalContent.push({ type: "thinking", thinking: lastThinkingText });
	}
	if (lastGenerationText) {
		finalContent.push({ type: "text", text: lastGenerationText });
	}

	const rawUsageDoc = current.conversation.docs["pi.usage"];
	const usageDoc: UsageDocument = isUsageDocument(rawUsageDoc) ? rawUsageDoc : {};
	return {
		role: "assistant",
		content: finalContent.length > 0 ? finalContent : [{ type: "text", text: "" }],
		stopReason: "stop",
		usage: {
			input: usageDoc.input,
			output: usageDoc.output,
			cacheRead: usageDoc.cacheRead,
			cacheWrite: usageDoc.cacheWrite,
			totalTokens: usageDoc.totalTokens ?? (usageDoc.input ?? 0) + (usageDoc.output ?? 0),
			cost: usageDoc.cost,
		},
	};
}
