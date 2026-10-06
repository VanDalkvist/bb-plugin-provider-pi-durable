import type { DurableView } from "../runtime.ts";
import type { LiveState } from "@earendil-works/pi-durable";

/**
 * Resolves tool call arguments from the active generation message or transcript entries.
 * Addresses defect D-1 / A-1 (AP-012, AP-026).
 */
export function resolveToolCallArgs(callId: string, current: DurableView): Record<string, unknown> {
	const live = (current.conversation.docs["pi.live"] ?? {}) as LiveState;

	// 1. Check current live generation message toolCalls
	const activeCalls = ((live.generation?.message?.content ?? []) as any[]).filter(
		(b) => b?.type === "toolCall",
	);
	if (activeCalls.length > 0) {
		const matched = activeCalls.find((c) => c.id === callId || c.callId === callId);
		if (matched?.arguments && typeof matched.arguments === "object") {
			return matched.arguments;
		}
	}

	// 2. Check recent assistant entries from the conversation transcript
	const entries = current.conversation.entries ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry?.kind === "pi.assistant" && Array.isArray(entry?.model)) {
			for (const msg of entry.model) {
				if (Array.isArray(msg?.content)) {
					for (const part of msg.content) {
						if (part.type === "toolCall" && (part.id === callId || part.callId === callId)) {
							if (part.arguments && typeof part.arguments === "object") {
								return part.arguments;
							}
						}
					}
				}
			}
		}
	}

	// 3. Fallback to slot input / args
	const slot = (live.tools ?? []).find((s) => (s.callId ?? String((s as any).id)) === callId) as any;
	if (slot?.args && typeof slot.args === "object") {
		return slot.args;
	}

	return {};
}
