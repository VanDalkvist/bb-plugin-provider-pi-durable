import type { TaskTreeItem } from "./types.ts";

export function hasActiveWork(item: TaskTreeItem): boolean {
	if (!item.isTerminal) return true;
	for (const child of item.children) {
		if (hasActiveWork(child)) return true;
	}
	return false;
}

export function sortTreeActiveFirst(items: readonly TaskTreeItem[]): TaskTreeItem[] {
	const active: TaskTreeItem[] = [];
	const finished: TaskTreeItem[] = [];

	for (const item of items) {
		const sortedChildren = item.children.length > 0 ? sortTreeActiveFirst(item.children) : item.children;
		const nextItem: TaskTreeItem = sortedChildren === item.children ? item : { ...item, children: sortedChildren };

		if (hasActiveWork(nextItem)) {
			active.push(nextItem);
		} else {
			finished.push(nextItem);
		}
	}

	active.sort((a, b) => a.id - b.id);
	finished.sort((a, b) => a.id - b.id);

	return [...active, ...finished];
}

interface RankedActiveTask {
	id: number;
	score: number;
	depth: number;
}

function getStatusScore(status?: string): number {
	switch (status) {
		case "running":
			return 100;
		case "completing":
			return 80;
		case "waiting":
			return 60;
		case "sleeping":
			return 40;
		case "pending":
			return 20;
		default:
			return 10;
	}
}

export function findBestActiveTaskId(tree: readonly TaskTreeItem[]): number | null {
	const candidates: RankedActiveTask[] = [];

	const walk = (items: readonly TaskTreeItem[], depth: number) => {
		for (const item of items) {
			if (!item.isTerminal && item.liveNode) {
				const score = getStatusScore(item.liveNode.state.status);
				candidates.push({ id: item.id, score, depth });
			}
			if (item.children.length > 0) {
				walk(item.children, depth + 1);
			}
		}
	};

	walk(tree, 0);

	if (candidates.length === 0) return null;

	candidates.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (b.depth !== a.depth) return b.depth - a.depth;
		return b.id - a.id;
	});

	return candidates[0].id;
}

export function hasDescendantId(item: TaskTreeItem, targetId: number): boolean {
	if (item.id === targetId) return true;
	for (const child of item.children) {
		if (hasDescendantId(child, targetId)) return true;
	}
	return false;
}

export function getFoldedHistorySummary(items: readonly TaskTreeItem[]): {
	total: number;
	failed: number;
	toolError: number;
} {
	let total = 0;
	let failed = 0;
	let toolError = 0;

	const walk = (list: readonly TaskTreeItem[]) => {
		for (const item of list) {
			total++;
			const outcome = item.receipt?.outcome;
			if (outcome === "failed" || outcome === "faulted") {
				failed++;
			}
			if (item.receipt?.isToolError) {
				toolError++;
			}
			if (item.children.length > 0) {
				walk(item.children);
			}
		}
	};

	walk(items);
	return { total, failed, toolError };
}
