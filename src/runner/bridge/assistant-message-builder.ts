import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { DurableView } from "../runtime.ts";
import type { BBAssistantMessage } from "./contracts.ts";

/**
 * Reconstructs or extracts the final assistant message and usage metrics for turn completion.
 */
export function buildFinalAssistantMessage(
	current: DurableView,
	lastGenerationText: string,
	lastThinkingText: string,
): BBAssistantMessage {
	const entries = current.conversation.entries ?? [];
	const lastAssistantEntry = [...entries].reverse().find((e: any) => e.kind === "pi.assistant") as any;
	const lastAssistantMsg = lastAssistantEntry?.model?.[0] as AssistantMessage | undefined;

	if (lastAssistantMsg) {
		return {
			role: "assistant",
			content: (lastAssistantMsg.content as any) ?? [{ type: "text", text: lastGenerationText }],
			stopReason: (lastAssistantMsg.stopReason as any) ?? "stop",
			usage: lastAssistantMsg.usage as any,
		};
	}

	const finalContent: BBAssistantMessage["content"] = [];
	if (lastThinkingText) {
		finalContent.push({ type: "thinking", thinking: lastThinkingText });
	}
	if (lastGenerationText) {
		finalContent.push({ type: "text", text: lastGenerationText });
	}

	const usageDoc = (current.conversation.docs["pi.usage"] ?? {}) as any;
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
