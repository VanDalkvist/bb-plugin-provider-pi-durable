import type { TaskTreeItem } from "./types.ts";
import { hasActiveWork } from "./tree-order.ts";

export interface HiddenBreakdown {
	readonly total: number;
	readonly hasFailure: boolean;
	readonly label: string;
}

export function countTotalNodes(items: readonly TaskTreeItem[]): number {
	let count = 0;
	const walk = (list: readonly TaskTreeItem[]) => {
		for (const item of list) {
			count++;
			if (item.children.length > 0) walk(item.children);
		}
	};
	walk(items);
	return count;
}

export function countActiveNodes(items: readonly TaskTreeItem[]): number {
	let count = 0;
	const walk = (list: readonly TaskTreeItem[]) => {
		for (const item of list) {
			if (hasActiveWork(item)) {
				count++;
			}
			if (item.children.length > 0) walk(item.children);
		}
	};
	walk(items);
	return count;
}

function collectFinishedInRenderOrder(items: readonly TaskTreeItem[]): TaskTreeItem[] {
	const active: TaskTreeItem[] = [];
	const finished: TaskTreeItem[] = [];

	for (const item of items) {
		if (hasActiveWork(item)) {
			active.push(item);
		} else {
			finished.push(item);
		}
	}

	active.sort((a, b) => a.id - b.id);
	finished.sort((a, b) => a.id - b.id);

	const result: TaskTreeItem[] = [];

	// Render order visits active items first, which may have finished children
	for (const item of active) {
		if (item.children.length > 0) {
			result.push(...collectFinishedInRenderOrder(item.children));
		}
	}

	// Then finished items themselves, and their finished children
	for (const item of finished) {
		result.push(item);
		if (item.children.length > 0) {
			result.push(...collectFinishedInRenderOrder(item.children));
		}
	}

	return result;
}

export function computePreviewFinishedIds(
	tree: readonly TaskTreeItem[],
	foldThreshold = 5,
): Set<number> {
	const total = countTotalNodes(tree);
	const allFinishedIds = new Set<number>();

	// Small total <= foldThreshold shows all without control
	if (total <= foldThreshold) {
		const walk = (list: readonly TaskTreeItem[]) => {
			for (const item of list) {
				if (!hasActiveWork(item)) allFinishedIds.add(item.id);
				if (item.children.length > 0) walk(item.children);
			}
		};
		walk(tree);
		return allFinishedIds;
	}

	const activeCount = countActiveNodes(tree);
	const targetFinishedCount = Math.max(0, foldThreshold - activeCount);
	if (targetFinishedCount === 0) {
		return new Set<number>();
	}

	const finishedInOrder = collectFinishedInRenderOrder(tree);
	const previewSlice = finishedInOrder.slice(0, targetFinishedCount);
	return new Set<number>(previewSlice.map((it) => it.id));
}

const PREFERRED_OUTCOME_ORDER = ["completed", "failed", "aborted", "cancelled", "faulted", "orphaned"] as const;

export function getHiddenBreakdown(
	items: readonly TaskTreeItem[],
	previewIds: ReadonlySet<number>,
): HiddenBreakdown {
	const counts = new Map<string, number>();
	let total = 0;
	let hasFailure = false;

	const walk = (list: readonly TaskTreeItem[]) => {
		for (const item of list) {
			if (!hasActiveWork(item) && !previewIds.has(item.id)) {
				total++;
				const outcome = item.receipt?.outcome ?? "completed";
				counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
				if (
					outcome === "failed" ||
					outcome === "faulted" ||
					Boolean(item.receipt?.isToolError)
				) {
					hasFailure = true;
				}
			}
			if (item.children.length > 0) {
				walk(item.children);
			}
		}
	};

	walk(items);

	if (total === 0) {
		return { total: 0, hasFailure: false, label: "" };
	}

	const orderedOutcomes: string[] = [];
	for (const o of PREFERRED_OUTCOME_ORDER) {
		if (counts.has(o)) {
			orderedOutcomes.push(o);
		}
	}
	const otherOutcomes = Array.from(counts.keys())
		.filter((k) => !(PREFERRED_OUTCOME_ORDER as readonly string[]).includes(k))
		.sort();
	orderedOutcomes.push(...otherOutcomes);

	const parts = orderedOutcomes.map((outcome) => `${counts.get(outcome)} ${outcome}`);
	const label = `See more (${parts.join(" · ")})`;

	return { total, hasFailure, label };
}
