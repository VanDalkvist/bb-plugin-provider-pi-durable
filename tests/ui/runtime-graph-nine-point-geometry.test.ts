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
const { RuntimeGraphDetails } = await import("../../src/ui/runtime-graph/details.tsx");
const { RuntimeGraphSegmentDetails } = await import("../../src/ui/runtime-graph/segment.tsx");

test.afterEach(() => {
	cleanup();
});

function makeTask(id: number, isTerminal = true, outcome: any = "completed"): TaskTreeItem {
	return {
		id, kind: "pi.tool", label: `Task #${id}`, conversationId: 1,
		isTerminal, children: [],
		receipt: isTerminal ? {
			taskId: id, conversationId: 1, kind: "pi.tool", outcome,
			endedAt: 1000 + id, durationMs: 25,
		} : undefined,
		liveNode: !isTerminal ? {
			id, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false,
			state: { status: "running" }, label: `Task #${id}`, startedAt: 1000,
		} : undefined,
	};
}

test("R4: 0..5 vs 6 boundary and terminal ancestor with active child", () => {
	// 0 tasks: empty state
	const { container: c0 } = render(React.createElement(RuntimeGraphTree, {
		tree: [], selectedTaskId: null, collapsedTaskIds: new Set(),
		onSelectTask: () => {}, onToggleCollapse: () => {},
	}));
	assert.ok(c0.textContent?.includes("No tasks in graph"));

	// 1 to 5 tasks: all shown, no See more/less
	for (const count of [1, 2, 3, 4, 5]) {
		cleanup();
		const tasks = Array.from({ length: count }, (_, i) => makeTask(i + 1, true));
		const { container } = render(React.createElement(RuntimeGraphTree, {
			tree: tasks, selectedTaskId: null, collapsedTaskIds: new Set(),
			onSelectTask: () => {}, onToggleCollapse: () => {},
		}));
		assert.equal(container.querySelector("button[data-history-toggle='true']") === null, true);
		assert.equal(container.querySelectorAll("[data-task-id]").length, count);
	}

	// 6 tasks: folds behind See more
	cleanup();
	const sixTasks = Array.from({ length: 6 }, (_, i) => makeTask(i + 1, true));
	const { container: c6 } = render(React.createElement(RuntimeGraphTree, {
		tree: sixTasks, selectedTaskId: null, collapsedTaskIds: new Set(),
		onSelectTask: () => {}, onToggleCollapse: () => {},
	}));
	assert.ok(c6.querySelector("button[data-history-toggle='true']"));
	assert.ok(c6.textContent?.includes("See more (1 completed)"));

	// Terminal parent with active child stays active and is NOT folded
	cleanup();
	const terminalParent = makeTask(100, true);
	const activeChild = makeTask(101, false);
	terminalParent.children = [activeChild];
	const finishedSiblings = [1, 2, 3, 4].map((id) => makeTask(id, true));

	const { container: cNested } = render(React.createElement(RuntimeGraphTree, {
		tree: [terminalParent, ...finishedSiblings], selectedTaskId: null,
		collapsedTaskIds: new Set(), onSelectTask: () => {}, onToggleCollapse: () => {},
	}));
	// Parent #100 has active child (2 active), finished siblings has 4 (total 6 > 5); preview shows 2 active + 3 finished = 5 rows, 1 hidden
	assert.ok(cNested.querySelector("button[data-history-toggle='true']"));
	assert.ok(cNested.textContent?.includes("See more (1 completed)"));
	assert.ok(cNested.querySelector("[data-task-id='100']"));
	assert.ok(cNested.querySelector("[data-task-id='101']"));
	assert.ok(cNested.querySelector("[data-task-id='1']"));
	assert.ok(cNested.querySelector("[data-task-id='3']"));
	assert.equal(cNested.querySelector("[data-task-id='4']") === null, true);
});

test("R7 & R8: Inspector header remains fixed, only body scrolls, and X supports keyboard", () => {
	let closed = false;
	const item: TaskTreeItem = {
		...makeTask(42, true),
		receipt: {
			taskId: 42, conversationId: 1, kind: "pi.tool", outcome: "completed",
			targetHint: "bb thread tell --mode queue", endedAt: 2000,
		},
	};
	const { container } = render(React.createElement(RuntimeGraphDetails, {
		selectedItem: item, onClose: () => { closed = true; },
	}));

	// Header container is flex-shrink-0 (stable/fixed)
	const header = container.querySelector(".flex-shrink-0.border-b");
	assert.ok(header, "Header must be flex-shrink-0 and border-b");
	assert.ok(header.textContent?.includes("Task Details"));

	// Body container is flex-1 overflow-y-auto min-h-0
	const body = container.querySelector(".overflow-y-auto.min-h-0");
	assert.ok(body, "Body must have overflow-y-auto min-h-0");

	// Close button is compact X with focus styles and keyboard support
	const closeBtn = header.querySelector("button[aria-label='Close task details']") as HTMLButtonElement;
	assert.ok(closeBtn, "Close button must exist in fixed header");
	assert.ok(closeBtn.className.includes("focus-visible:ring-1"));

	// Trigger Enter key
	fireEvent.keyDown(closeBtn, { key: "Enter" });
	assert.equal(closed, true, "Enter key on X button must trigger onClose");

	// Reset and trigger click
	closed = false;
	fireEvent.click(closeBtn);
	assert.equal(closed, true, "Click on X button must trigger onClose");
});

test("R9: Long unbroken tokens, multiline errors, and narrow/wide layout wrapping", () => {
	const longUnbrokenToken = "A".repeat(120);
	const multilineError = "Error: System failed\n  at worker.ts:42:15\n  at process.run\n" + "B".repeat(100);
	const item: TaskTreeItem = {
		...makeTask(88, true, "failed"),
		receipt: {
			taskId: 88, conversationId: 1, kind: "pi.tool", outcome: "failed", isToolError: true,
			targetHint: `https://example.com/very/long/path/${longUnbrokenToken}`,
			preview: `output with ${longUnbrokenToken}`,
			error: { code: "UNBROKEN_FAIL", message: multilineError },
			endedAt: 3000,
		},
	};

	const { container } = render(React.createElement(RuntimeGraphDetails, { selectedItem: item }));

	// Target hint wraps with break-all or [overflow-wrap:anywhere]
	const targetSpan = container.querySelector("span[title*='very/long/path']");
	assert.ok(targetSpan, "Target span must exist");
	assert.ok(targetSpan.className.includes("[overflow-wrap:anywhere]") || targetSpan.className.includes("break-all"));

	// Error pre wraps and allows scroll
	const errorPre = container.querySelector("pre.text-red-600");
	assert.ok(errorPre, "Error pre must exist");
	assert.ok(errorPre.className.includes("break-all"));
	assert.ok(errorPre.className.includes("whitespace-pre-wrap"));

	// Test in segment in narrow layout
	cleanup();
	const state: any = {
		threadId: "thr-1", status: "ok",
		snapshot: { nodes: {}, receipts: [item.receipt], stats: { liveCount: 0, terminalCount: 1, totalCount: 1 } },
		tree: [item], selectedTaskId: 88, selectedItem: item,
		collapsedTaskIds: new Set(), selectTask: () => {}, toggleCollapse: () => {},
	};
	const { container: cNarrow } = render(React.createElement(RuntimeGraphSegmentDetails, {
		threadId: "thr-1", projectId: "p-1", environment: null, segments: [],
		isExpanded: true, onToggle: () => {}, testState: state,
	}));
	const inspector = cNarrow.querySelector("[data-testid='runtime-graph-inspector']");
	assert.ok(inspector, "Inspector mounts in segment");
	assert.ok(inspector.className.includes("overflow-hidden"), "Inspector container must be overflow-hidden, letting body scroll");
});
