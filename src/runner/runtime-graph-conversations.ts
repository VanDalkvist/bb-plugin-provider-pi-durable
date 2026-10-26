import type { RuntimeConversationNode } from "../runtime-graph/types.ts";

export class RuntimeGraphConversations {
	private readonly known = new Map<string, RuntimeConversationNode>();

	constructor(rootConversationId: string) {
		this.known.set(rootConversationId, { id: Number(rootConversationId) });
	}

	recordFromLiveNode(convId: number, id: number, ownedConversations?: readonly (number | string)[]): void {
		const convStr = String(convId);
		if (!this.known.has(convStr)) {
			this.known.set(convStr, { id: convId });
		}
		for (const ownedConvId of ownedConversations ?? []) {
			const cid = Number(ownedConvId);
			this.known.set(String(cid), {
				id: cid,
				owner: { conversationId: convId, taskId: id },
			});
		}
	}

	recordConversation(conv: {
		id: unknown;
		owner?: { conversationId: unknown; taskId: unknown };
		parent?: { conversationId: unknown; at: unknown };
	}): void {
		const cid = Number(conv.id);
		const existing = this.known.get(String(cid)) ?? { id: cid };
		const owner = conv.owner
			? { conversationId: Number(conv.owner.conversationId), taskId: Number(conv.owner.taskId) }
			: existing.owner;
		const parent = conv.parent
			? { conversationId: Number(conv.parent.conversationId), at: Number(conv.parent.at) }
			: existing.parent;
		this.known.set(String(cid), { id: cid, ...(owner ? { owner } : {}), ...(parent ? { parent } : {}) });
	}

	snapshot(): Record<string, RuntimeConversationNode> {
		return Object.fromEntries(this.known);
	}
}
