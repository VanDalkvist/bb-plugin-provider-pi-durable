import type {
	RuntimeGraphSnapshot,
	RuntimeConversationNode,
	RuntimeTaskNode,
	RuntimeTaskReceipt,
} from "../runtime-graph/types.ts";

export interface ConversationScopeRecord {
	readonly id: number;
	readonly owner?: {
		readonly conversationId: number;
		readonly taskId: number;
	};
	readonly parent?: {
		readonly conversationId: number;
		readonly at: number;
	};
}

/**
 * Checks if a conversation is in scope for the given target conversation.
 * Root conversation (1) sees all child conversations in the session.
 * A child conversation sees itself and any conversations owned (transitively) by its tasks.
 * Fork parent edges (`parent`) are NOT ownership edges and do not confer scope.
 */
export function isConversationInScope(
	conversationId: number,
	targetConversationId: number,
	conversations: Map<number, ConversationScopeRecord>,
): boolean {
	if (targetConversationId === 1) return true;
	if (conversationId === targetConversationId) return true;

	let currentId: number | undefined = conversationId;
	const visited = new Set<number>();

	while (currentId !== undefined && !visited.has(currentId)) {
		visited.add(currentId);
		const record = conversations.get(currentId);
		if (!record || !record.owner) {
			return false;
		}
		const ownerConversationId = record.owner.conversationId;
		if (ownerConversationId === targetConversationId) {
			return true;
		}
		currentId = ownerConversationId;
	}

	return false;
}

/**
 * Filters a complete session snapshot down to the scope of a specific conversation.
 */
export function filterSnapshotForConversation(
	snapshot: RuntimeGraphSnapshot,
	targetConversationId: number | string,
): RuntimeGraphSnapshot {
	const targetId = Number(targetConversationId);
	const rootId = Number(snapshot.scope.rootConversationId);
	if (targetId === rootId) {
		return snapshot;
	}

	const conversationsMap = new Map<number, ConversationScopeRecord>();
	for (const conv of Object.values(snapshot.conversations)) {
		conversationsMap.set(conv.id, conv);
	}

	const filteredNodes: Record<string, RuntimeTaskNode> = {};
	for (const [key, node] of Object.entries(snapshot.nodes)) {
		if (isConversationInScope(node.conversationId, targetId, conversationsMap)) {
			filteredNodes[key] = node;
		}
	}

	const filteredConversations: Record<string, RuntimeConversationNode> = {};
	for (const [key, conv] of Object.entries(snapshot.conversations)) {
		if (isConversationInScope(conv.id, targetId, conversationsMap)) {
			filteredConversations[key] = conv;
		}
	}

	const filteredReceipts: RuntimeTaskReceipt[] = [];
	for (const receipt of snapshot.receipts) {
		if (isConversationInScope(receipt.conversationId, targetId, conversationsMap)) {
			filteredReceipts.push(receipt);
		}
	}

	const liveCount = Object.keys(filteredNodes).length;
	const terminalCount = filteredReceipts.length;

	return {
		version: 1,
		scope: snapshot.scope,
		observation: snapshot.observation,
		nodes: filteredNodes,
		conversations: filteredConversations,
		receipts: filteredReceipts,
		stats: {
			liveCount,
			terminalCount,
			totalCount: liveCount + terminalCount,
		},
	};
}
