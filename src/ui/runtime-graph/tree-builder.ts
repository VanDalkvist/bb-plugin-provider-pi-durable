import type {
	RuntimeGraphSnapshot,
	RuntimeTaskNode,
	RuntimeTaskReceipt,
} from "../../runtime-graph/types.ts";
import type { TaskTreeItem } from "./types.ts";

interface MutableTreeItem {
	id: number;
	kind: string;
	label: string;
	conversationId: number;
	ownerId?: number;
	isTerminal: boolean;
	liveNode?: RuntimeTaskNode;
	receipt?: RuntimeTaskReceipt;
	waitingOn?: readonly number[];
	children: MutableTreeItem[];
}

function resolveOwnerId(
	convId: number,
	explicitOwner: number | undefined,
	conversations: RuntimeGraphSnapshot["conversations"],
): number | undefined {
	if (explicitOwner !== undefined) return explicitOwner;
	const conv = conversations[String(convId)];
	if (conv?.owner?.taskId !== undefined) {
		return conv.owner.taskId;
	}
	return undefined;
}

export function buildTaskTree(snapshot: RuntimeGraphSnapshot): TaskTreeItem[] {
	const itemsMap = new Map<number, MutableTreeItem>();
	const { nodes, receipts, conversations } = snapshot;

	// 1. Process live nodes
	for (const node of Object.values(nodes)) {
		const id = node.id;
		const ownerId = resolveOwnerId(node.conversationId, node.owner, conversations);
		const waitingOn = node.state.status === "waiting" ? node.state.on : undefined;

		itemsMap.set(id, {
			id,
			kind: node.kind,
			label: node.label,
			conversationId: node.conversationId,
			ownerId,
			isTerminal: false,
			liveNode: node,
			waitingOn,
			children: [],
		});
	}

	// 2. Process terminal receipts
	for (const receipt of receipts) {
		const id = receipt.taskId;
		const existing = itemsMap.get(id);

		if (existing) {
			existing.receipt = receipt;
			if (existing.liveNode?.state.status === "completing") {
				// Completing state remains until evicted from live nodes
				existing.isTerminal = false;
			} else {
				existing.isTerminal = true;
			}
		} else {
			const ownerId = resolveOwnerId(receipt.conversationId, undefined, conversations);
			const label = receipt.preview
				? `${receipt.kind} · ${receipt.preview}`
				: `${receipt.kind} #${id}`;

			itemsMap.set(id, {
				id,
				kind: receipt.kind,
				label,
				conversationId: receipt.conversationId,
				ownerId,
				isTerminal: true,
				receipt,
				children: [],
			});
		}
	}

	// 3. Assemble ownership hierarchy
	const rootItems: MutableTreeItem[] = [];

	for (const item of itemsMap.values()) {
		if (
			item.ownerId !== undefined &&
			item.ownerId !== item.id &&
			itemsMap.has(item.ownerId)
		) {
			itemsMap.get(item.ownerId)!.children.push(item);
		} else {
			rootItems.push(item);
		}
	}

	// 4. Stable sort by id
	const sortItems = (items: MutableTreeItem[]) => {
		items.sort((a, b) => a.id - b.id);
		for (const child of items) {
			if (child.children.length > 0) {
				sortItems(child.children);
			}
		}
	};

	sortItems(rootItems);
	return rootItems as TaskTreeItem[];
}

export function findTreeItem(items: readonly TaskTreeItem[], id: number | null): TaskTreeItem | null {
	if (id === null) return null;
	for (const item of items) {
		if (item.id === id) return item;
		if (item.children.length > 0) {
			const found = findTreeItem(item.children, id);
			if (found) return found;
		}
	}
	return null;
}
