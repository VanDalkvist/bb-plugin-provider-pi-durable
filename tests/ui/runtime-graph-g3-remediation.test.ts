import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { RuntimeGraphSnapshot } from "../../src/runtime-graph/types.ts";
import { buildTaskTree } from "../../src/ui/runtime-graph/tree-builder.ts";
import { RuntimeGraphNodeRow } from "../../src/ui/runtime-graph/node-row.tsx";
import { RuntimeGraphDetails } from "../../src/ui/runtime-graph/details.tsx";
import { RuntimeGraphSummary } from "../../src/ui/runtime-graph/summary.tsx";
import { useRuntimeGraphVisible } from "../../src/ui/runtime-graph/use-runtime-graph-visible.ts";

setupDom();
const { render } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();

function createMockSnapshot(overrides?: Partial<RuntimeGraphSnapshot>): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "session-1", rootConversationId: "1", buildId: "build-1" },
		observation: { epoch: "epoch-1", revision: 1, observedAt: 1000, completeness: "complete" },
		nodes: {},
		conversations: { "1": { id: 1 } },
		receipts: [],
		stats: { liveCount: 0, terminalCount: 0, totalCount: 0 },
		...overrides,
	};
}

test("D1 RED: terminal child receipt retains owner branch, does not flatten to root", () => {
	// Task 10 (generation) spawned Task 11 (bash). Task 11 completed and is in receipts with owner: 10
	const snapshot = createMockSnapshot({
		nodes: {
			"10": {
				id: 10, kind: "pi.generation", conversationId: 1,
				background: false, abortRequested: false,
				state: { status: "running", phase: "generating" }, label: "Root Gen",
			},
		},
		receipts: [
			{
				taskId: 11, conversationId: 1, owner: 10, kind: "bash",
				outcome: "completed", endedAt: 1200, durationMs: 200, preview: "npm test",
			},
		],
	});

	const tree = buildTaskTree(snapshot);
	assert.equal(tree.length, 1, "Only root task 10 should be in tree roots");
	assert.equal(tree[0].id, 10);
	assert.equal(tree[0].children.length, 1, "Terminal receipt 11 must be child of task 10");
	assert.equal(tree[0].children[0].id, 11);
	assert.equal(tree[0].children[0].isTerminal, true);
	assert.equal(tree[0].children[0].ownerId, 10);
});

test("D1 RED: cyclic ownership does not silently drop tasks from tree", () => {
	const snapshot = createMockSnapshot({
		receipts: [
			{ taskId: 1, conversationId: 1, owner: 2, kind: "task1", outcome: "completed", endedAt: 1000 },
			{ taskId: 2, conversationId: 1, owner: 1, kind: "task2", outcome: "completed", endedAt: 1000 },
		],
	});

	const tree = buildTaskTree(snapshot);
	// Both tasks must be present in tree (not silently discarded)
	const allIds = new Set<number>();
	function collect(items: typeof tree) {
		for (const it of items) {
			allIds.add(it.id);
			if (it.children) collect(it.children);
		}
	}
	collect(tree);
	assert.ok(allIds.has(1), "Task 1 must not be dropped due to cycle");
	assert.ok(allIds.has(2), "Task 2 must not be dropped due to cycle");
});

test("D3 RED: summary displays unavailable warning, NOT false green checkmark", () => {
	const stateUnavailable: any = {
		threadId: "thr-1", status: "unavailable", snapshot: null,
		tree: [], selectedTaskId: null, selectedItem: null,
		collapsedTaskIds: new Set(), selectTask: () => {}, toggleCollapse: () => {},
	};

	const { container } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: false, onToggle: () => {}, testState: stateUnavailable,
		}),
	);

	assert.ok(!container.textContent?.includes("No active tasks"), "Must not mask unavailable as 'no active tasks'");
	assert.ok(container.textContent?.includes("Task graph unavailable") || container.textContent?.includes("unavailable"), "Must show unavailable warning");
	// Icon must not be Check
	const svgIcons = container.querySelectorAll("[data-icon-name]");
	assert.ok(!Array.from(svgIcons).some((i) => i.getAttribute("data-icon-name") === "Check"), "Checkmark must not be shown on unavailable");
});

test("D3 RED: summary uses grammatically correct singular and plural for active tasks", () => {
	const makeActiveState = (activeCount: number): any => {
		const nodes: any = {};
		for (let i = 1; i <= activeCount; i++) {
			nodes[String(i)] = {
				id: i, kind: "task", conversationId: 1,
				background: false, abortRequested: false,
				state: { status: "running" }, label: `Task ${i}`,
			};
		}
		return {
			threadId: "thr-1", status: "ok",
			snapshot: createMockSnapshot({ nodes, stats: { liveCount: activeCount, terminalCount: 0, totalCount: activeCount } }),
			tree: [], selectedTaskId: null, selectedItem: null,
			collapsedTaskIds: new Set(), selectTask: () => {}, toggleCollapse: () => {},
		};
	};

	const { container: c1 } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: false, onToggle: () => {}, testState: makeActiveState(1),
		}),
	);
	assert.ok(c1.textContent?.includes("1 active"), `Expected '1 active', got ${c1.textContent}`);
	assert.ok(!c1.textContent?.includes("активн"), "Must not contain Russian word 'активн'");

	const { container: c2 } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: false, onToggle: () => {}, testState: makeActiveState(2),
		}),
	);
	assert.ok(c2.textContent?.includes("2 active"), `Expected '2 active', got ${c2.textContent}`);
});

test("D4 RED: inspector displays both preview and error diagnostics when task failed", () => {
	const itemWithError: any = {
		id: 12, kind: "bash", label: "bash: failed build", conversationId: 1,
		isTerminal: true, children: [],
		receipt: {
			taskId: 12, conversationId: 1, kind: "bash", outcome: "failed",
			endedAt: 2000, durationMs: 150,
			preview: "bash · exit code 1",
			error: { message: "Command failed with exit code 1: make test", code: "EEXIT_1" },
		},
	};

	const { container } = render(React.createElement(RuntimeGraphDetails, { selectedItem: itemWithError }));
	assert.ok(container.textContent?.includes("bash · exit code 1"), "Preview must be displayed");
	assert.ok(container.textContent?.includes("Command failed with exit code 1: make test"), "Error message must NOT be hidden by preview");
	assert.ok(container.textContent?.includes("EEXIT_1"), "Error code must be displayed");
});

test("D6 RED: node row does not nest button inside role=button and provides aria-expanded", () => {
	const itemWithChildren: any = {
		id: 10, kind: "pi.generation", label: "Root Gen", conversationId: 1,
		isTerminal: false, children: [{ id: 11 }],
		liveNode: { id: 10, state: { status: "running" } },
	};

	const { container } = render(
		React.createElement(RuntimeGraphNodeRow, {
			item: itemWithChildren, depth: 0, isSelected: false, isCollapsed: false,
			onSelect: () => {}, onToggleCollapse: () => {},
		}),
	);

	// Check for invalid nesting: button inside role="button"
	const roleButton = container.querySelector('[role="button"]');
	if (roleButton) {
		const nestedBtn = roleButton.querySelector("button");
		assert.equal(nestedBtn, null, "MUST NOT nest button inside role=button container");
	}

	// Chevron button must have aria-expanded
	const chevronBtn = container.querySelector("button");
	assert.ok(chevronBtn, "Chevron button must exist");
	assert.equal(chevronBtn.getAttribute("aria-expanded"), "true", "Chevron must specify aria-expanded");
});

test("D7 RED: visibility fails closed for foreign threads not in sidebar", async () => {
	const foreignNotVisible = useRuntimeGraphVisible({
		threadId: "foreign-thread-999",
		projectId: "proj-1",
		environment: null,
	}, {
		sidebarThreads: {
			status: "ready",
			threads: [{ id: "other-thread", providerId: "pi-durable" } as any],
		},
		authoritativeProviderId: "anthropic",
	});
	assert.equal(foreignNotVisible, false, "Unknown thread of foreign provider must return false");
});
