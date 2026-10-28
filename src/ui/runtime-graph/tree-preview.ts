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
			if (hasActiveWork(item)) count++;
			if (item.children.length > 0) walk(item.children);
		}
	};
	walk(items);
	return count;
}

/**
 * Computes visible finished root task IDs for root-level folding.
 * History folding applies strictly to root tasks, never inside child branches.
 */
export function computePreviewFinishedIds(
	tree: readonly TaskTreeItem[],
	foldThreshold = 5,
): Set<number> {
	if (tree.length <= foldThreshold) {
		const allFinished = new Set<number>();
		for (const item of tree) {
			if (!hasActiveWork(item)) allFinished.add(item.id);
		}
		return allFinished;
	}

	const activeCount = tree.filter(hasActiveWork).length;
	const targetFinishedCount = Math.max(0, foldThreshold - activeCount);
	if (targetFinishedCount === 0) {
		return new Set<number>();
	}

	const finished = tree.filter((it) => !hasActiveWork(it)).slice();
	finished.sort((a, b) => a.id - b.id);
	const previewSlice = finished.slice(0, targetFinishedCount);
	return new Set<number>(previewSlice.map((it) => it.id));
}

const PREFERRED_OUTCOME_ORDER = ["completed", "failed", "aborted", "cancelled", "faulted", "orphaned"] as const;

/**
 * Summarizes hidden root tasks (and their subtrees) for the root See more toggle.
 */
export function getHiddenBreakdown(
	items: readonly TaskTreeItem[],
	previewIds: ReadonlySet<number>,
): HiddenBreakdown {
	const counts = new Map<string, number>();
	let total = 0;
	let hasFailure = false;

	const walk = (list: readonly TaskTreeItem[]) => {
		for (const item of list) {
			total++;
			const outcome = item.receipt?.outcome ?? "completed";
			counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
			if (outcome === "failed" || outcome === "faulted" || Boolean(item.receipt?.isToolError)) {
				hasFailure = true;
			}
			if (item.children.length > 0) {
				walk(item.children);
			}
		}
	};

	for (const item of items) {
		if (!hasActiveWork(item) && !previewIds.has(item.id)) {
			walk([item]);
		}
	}

	if (total === 0) {
		return { total: 0, hasFailure: false, label: "" };
	}

	const orderedOutcomes: string[] = [];
	for (const o of PREFERRED_OUTCOME_ORDER) {
		if (counts.has(o)) orderedOutcomes.push(o);
	}
	const otherOutcomes = Array.from(counts.keys())
		.filter((k) => !(PREFERRED_OUTCOME_ORDER as readonly string[]).includes(k))
		.sort();
	orderedOutcomes.push(...otherOutcomes);

	const parts = orderedOutcomes.map((outcome) => `${counts.get(outcome)} ${outcome}`);
	const label = `See more (${parts.join(" · ")})`;

	return { total, hasFailure, label };
}
