import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { TaskTreeItem } from "../../src/ui/runtime-graph/types.ts";

setupDom();
const { render, fireEvent, cleanup } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphTree } = await import("../../src/ui/runtime-graph/tree.tsx");
const { RuntimeGraphSummary } = await import("../../src/ui/runtime-graph/summary.tsx");
const { RuntimeGraphSegmentDetails } = await import("../../src/ui/runtime-graph/segment.tsx");
const { RuntimeGraphDetails } = await import("../../src/ui/runtime-graph/details.tsx");

test.afterEach(() => {
	cleanup();
});

function makeTask(id: number, isTerminal = true, outcome: any = "completed", isToolError = false): TaskTreeItem {
	return {
		id, kind: "pi.tool", label: `Task #${id}`, conversationId: 1,
		isTerminal, children: [],
		receipt: isTerminal ? {
			taskId: id, conversationId: 1, kind: "pi.tool", outcome, isToolError,
			endedAt: 1000 + id, durationMs: 15,
		} : undefined,
		liveNode: !isTerminal ? {
			id, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false,
			state: { status: "running" }, label: `Task #${id}`, startedAt: 1000,
		} : undefined,
	};
}

test("Requirement 1 RED: See less collapses history branch even when selected terminal task is inside", () => {
	const tasks = [1, 2, 3, 4, 5, 6, 7].map((id) => makeTask(id, true));
	let selectedId: number | null = null;

	const Wrapper = () => {
		const [selected, setSelected] = React.useState<number | null>(null);
		return React.createElement(RuntimeGraphTree, {
			tree: tasks, selectedTaskId: selected, collapsedTaskIds: new Set(),
			onSelectTask: (id) => { selectedId = id; setSelected(id); },
			onToggleCollapse: () => {},
		});
	};

	const { container } = render(React.createElement(Wrapper));
	const seeMoreBtn = container.querySelector("button[data-history-toggle='true']");
	assert.ok(seeMoreBtn, "Should have See more button for 7 items");
	fireEvent.click(seeMoreBtn);

	// Select task #3
	const task3Row = container.querySelector("[data-task-id='3']");
	assert.ok(task3Row, "Task 3 row must be visible");
	fireEvent.click(task3Row);
	assert.equal(selectedId, 3, "Task 3 must be selected");

	// Now click See less while task #3 is selected
	const seeLessBtn = container.querySelector("button[data-history-toggle='true']");
	assert.ok(seeLessBtn?.textContent?.includes("See less"), "Button must now be See less");
	fireEvent.click(seeLessBtn!);

	// Crucial check: See less MUST collapse the branch!
	const seeMoreAfter = container.querySelector("button[data-history-toggle='true']");
	assert.ok(seeMoreAfter?.textContent?.includes("See more"), "Branch must collapse back to See more even when selected");
	assert.equal(container.querySelector("[data-task-id='3']"), null, "Task 3 row must be folded away");
});

test("Requirement 2 RED: History disclosure stays neutral chevron even when group has failures", () => {
	const tasks = [1, 2, 3, 4, 5, 6, 7].map((id) => makeTask(id, true, id === 7 ? "failed" : "completed"));
	const { container } = render(React.createElement(RuntimeGraphTree, {
		tree: tasks, selectedTaskId: null, collapsedTaskIds: new Set(),
		onSelectTask: () => {}, onToggleCollapse: () => {},
	}));

	const toggleBtn = container.querySelector("button[data-history-toggle='true']");
	assert.ok(toggleBtn, "Toggle button exists");
	// Must keep honest failure count
	assert.ok(toggleBtn.textContent?.includes("1 failed"), "Text honestly reports failure count");
	// Must NOT use AlertTriangle or red icon for the whole group disclosure
	assert.ok(toggleBtn.innerHTML.includes("ChevronDown"), "Disclosure icon must stay neutral ChevronDown");
	assert.ok(!toggleBtn.innerHTML.includes("AlertTriangle"), "Disclosure icon must NOT be AlertTriangle");
	assert.ok(!toggleBtn.innerHTML.includes("text-red-500"), "Disclosure icon must NOT have text-red-500");
});

test("Requirement 3 RED: Inactive header is muted grey; active tasks show English 'N active of M'", () => {
	// Inactive / unselected state
	const inactiveState: any = {
		threadId: "thr-1", status: "ok", snapshot: { nodes: {}, receipts: [], stats: { liveCount: 0, terminalCount: 10, totalCount: 10 } },
		tree: [], selectedTaskId: null, selectedItem: null, collapsedTaskIds: new Set(),
		selectTask: () => {}, toggleCollapse: () => {},
	};
	const { container: cInactive } = render(React.createElement(RuntimeGraphSummary, {
		threadId: "thr-1", projectId: "p-1", environment: null, segments: [], isExpanded: false, onToggle: () => {}, testState: inactiveState,
	}));
	const inactiveTitle = cInactive.querySelector("button > span.font-semibold");
	assert.ok(inactiveTitle?.classList.contains("text-muted-foreground"), "Inactive unselected header must be text-muted-foreground");

	// Active state with 2 active of 130
	const activeState: any = {
		threadId: "thr-1", status: "ok",
		snapshot: {
			nodes: { "1": makeTask(1, false).liveNode, "2": makeTask(2, false).liveNode },
			receipts: Array.from({ length: 128 }, (_, i) => makeTask(10 + i, true).receipt),
			stats: { liveCount: 2, terminalCount: 128, totalCount: 130 },
		},
		tree: [], selectedTaskId: null, selectedItem: null, collapsedTaskIds: new Set(),
		selectTask: () => {}, toggleCollapse: () => {},
	};
	const { container: cActive } = render(React.createElement(RuntimeGraphSummary, {
		threadId: "thr-1", projectId: "p-1", environment: null, segments: [], isExpanded: false, onToggle: () => {}, testState: activeState,
	}));
	assert.ok(cActive.textContent?.includes("2 active of 130"), `Expected '2 active of 130', got: ${cActive.textContent}`);
});

test("Requirement 4 RED: Subtree/history group with <= 5 nodes shows all with no See more/less", () => {
	// Exactly 5 nodes: NO see more/less
	const fiveTasks = [1, 2, 3, 4, 5].map((id) => makeTask(id, true));
	const { container: c5 } = render(React.createElement(RuntimeGraphTree, {
		tree: fiveTasks, selectedTaskId: null, collapsedTaskIds: new Set(),
		onSelectTask: () => {}, onToggleCollapse: () => {},
	}));
	assert.equal(c5.querySelector("button[data-history-toggle='true']"), null, "5 tasks should NOT have See more/less");
	assert.equal(c5.querySelectorAll("[data-task-id]").length, 5, "All 5 tasks should be visible directly");

	// 6 nodes: MUST have See more
	cleanup();
	const sixTasks = [1, 2, 3, 4, 5, 6].map((id) => makeTask(id, true));
	const { container: c6 } = render(React.createElement(RuntimeGraphTree, {
		tree: sixTasks, selectedTaskId: null, collapsedTaskIds: new Set(),
		onSelectTask: () => {}, onToggleCollapse: () => {},
	}));
	assert.ok(c6.querySelector("button[data-history-toggle='true']"), "6 tasks MUST have See more");
});

test("Requirement 6 RED: Follow active button is completely removed", () => {
	const activeItem = makeTask(50, false);
	const state: any = {
		threadId: "thr-1", status: "ok",
		snapshot: { nodes: { "50": activeItem.liveNode }, receipts: [], stats: { liveCount: 1, terminalCount: 0, totalCount: 1 } },
		tree: [activeItem], selectedTaskId: null, selectedItem: null,
		collapsedTaskIds: new Set(), selectTask: () => {}, toggleCollapse: () => {},
	};
	const { container } = render(React.createElement(RuntimeGraphSegmentDetails, {
		threadId: "thr-1", projectId: "p-1", environment: null, segments: [], isExpanded: true, onToggle: () => {}, testState: state,
	}));
	assert.equal(container.querySelector("button[aria-label='Follow active']"), null, "Follow active button must not exist");
});

test("Requirement 7-9 RED: Inspector has fixed header, X button, and wraps long target commands", () => {
	const item: TaskTreeItem = {
		...makeTask(99, true),
		receipt: {
			taskId: 99, conversationId: 1, kind: "pi.tool", outcome: "completed", endedAt: 2000,
			targetHint: "bb thread tell thr_t3x53wmjif --mode queue --message-file /very/long/path/with_unbroken_tokens/without_spaces",
		},
	};
	let closed = false;
	const { container } = render(React.createElement(RuntimeGraphDetails, {
		selectedItem: item, onClose: () => { closed = true; },
	}));

	// Header has X button with aria-label="Close task details"
	const closeBtn = container.querySelector("button[aria-label='Close task details']");
	assert.ok(closeBtn, "Must have button with aria-label='Close task details'");
	assert.equal(closeBtn?.textContent?.trim(), "", "Should be icon button (X), not text 'Close'");
	assert.ok(closeBtn?.innerHTML.includes("X"), "Should render X icon");
	fireEvent.click(closeBtn!);
	assert.equal(closed, true, "Clicking X must call onClose");

	// Target command must wrap and not use truncate max-w-[200px]
	const targetSpan = container.querySelector("span[title*='bb thread tell']");
	assert.ok(targetSpan, "Target span exists");
	assert.ok(!targetSpan.classList.contains("truncate"), "Target span must NOT truncate in inspector");
	assert.ok(targetSpan.className.includes("break-words") || targetSpan.className.includes("overflow-wrap"), "Target span must wrap");
});
