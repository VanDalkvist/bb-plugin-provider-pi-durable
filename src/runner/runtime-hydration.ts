import type { ConversationId, Cursor, Harness } from "@earendil-works/pi-durable";
import { firstInput, type ConversationSummary, runtimeContext } from "./runtime-types.ts";

export function hydrateSessionActiveTools(
	rootAgent: { readonly tools?: readonly { readonly name: string }[] | undefined },
	activeEnvState: { readonly setActiveTools?: (tools: string[]) => void },
): void {
	if (Array.isArray(rootAgent.tools)) {
		activeEnvState.setActiveTools?.(rootAgent.tools.map((t) => t.name));
	}
}

export async function loadSummaries(harness: Harness, rootId: ConversationId): Promise<ConversationSummary[]> {
	const summaries: ConversationSummary[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), runtimeContext);
		for (const { id } of page.items) summaries.push({ id, label: id === rootId ? "main" : `subagent ${id}`, ...(await firstInput(harness, id)) });
		cursor = page.next;
	} while (cursor !== undefined);
	return summaries;
}
