import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { TaskTreeItem } from "../../src/ui/runtime-graph/types.ts";

setupDom();
const { render, fireEvent } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphTree } = await import("../../src/ui/runtime-graph/tree.tsx");
const { sortTreeActiveFirst, hasActiveWork } = await import("../../src/ui/runtime-graph/tree-order.ts");

function makeTask(id: number, isTerminal: boolean, outcome?: string, children: TaskTreeItem[] = []): TaskTreeItem {
	return {
		id,
		kind: "pi.tool",
		label: `Task #${id}`,
		conversationId: 1,
		isTerminal,
		liveNode: isTerminal ? undefined : ({
			id, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false,
			state: { status: "running" }, label: `Task #${id}`,
		} as any),
		receipt: isTerminal ? ({
			taskId: id, kind: "pi.tool", conversationId: 1,
			outcome: outcome ?? "completed", durationMs: 120,
		} as any) : undefined,
		children,
	};
}

test("Active-first recursive ordering: active tasks precede finished at every level with stable ID", () => {
	// Root tasks: #1 (finished), #2 (running), #3 (waiting), #4 (finished)
	// Child tasks under #2: #21 (finished), #22 (running)
	const child21 = makeTask(21, true);
	const child22 = makeTask(22, false);
	const t1 = makeTask(1, true);
	const t2 = makeTask(2, false, undefined, [child21, child22]);
	const t3 = makeTask(3, false);
	const t4 = makeTask(4, true);

	const tree = [t1, t2, t3, t4];
	const sorted = sortTreeActiveFirst(tree);

	// Root level: #2 and #3 are active (descending: #3, #2), #1 and #4 are finished (descending: #4, #1)
	assert.deepEqual(sorted.map((t) => t.id), [3, 2, 4, 1]);

	// Child level under #2: #22 is active, #21 is finished
	const sortedT2 = sorted.find((t) => t.id === 2)!;
	assert.deepEqual(sortedT2.children.map((c) => c.id), [22, 21]);
});

test("Terminal parent with live descendant stays in active branch and is not folded", () => {
	// Parent #5 is terminal, but has child #50 that is running
	const child50 = makeTask(50, false);
	const parent5 = makeTask(5, true, "completed", [child50]);
	const terminal6 = makeTask(6, true);

	assert.equal(hasActiveWork(parent5), true);
	assert.equal(hasActiveWork(terminal6), false);

	const sorted = sortTreeActiveFirst([terminal6, parent5]);
	assert.equal(sorted[0].id, 5, "Terminal parent with live child must come before purely terminal tasks");
	assert.equal(sorted[1].id, 6);
});

test("Finished-only siblings fold behind English See more and toggle with See less", () => {
	const active1 = makeTask(1, false);
	const finished = [2, 3, 4, 5, 6, 7].map((id) => makeTask(id, true));

	const { container } = render(React.createElement(RuntimeGraphTree, {
		tree: [active1, ...finished],
		selectedTaskId: null,
		collapsedTaskIds: new Set(),
		onSelectTask: () => {},
		onToggleCollapse: () => {},
	}));

	assert.ok(container.textContent?.includes("Task #1"));
	// When folded by default (1 active + 6 finished: 7..2), preview fills to 5 (active #1 + 4 finished: 7..4), remaining 2 (3..2) go under See more (2 completed)
	const seeMoreBtn = container.querySelector("button[data-history-toggle='true']");
	assert.ok(seeMoreBtn, "See more control should be rendered for finished siblings");
	assert.ok(seeMoreBtn?.textContent?.includes("See more (2 completed)"));
	assert.ok(container.textContent?.includes("Task #7"));
	assert.ok(!container.textContent?.includes("Task #2"));

	// Click to expand
	fireEvent.click(seeMoreBtn!);
	assert.ok(container.textContent?.includes("Task #2"));
	assert.ok(container.textContent?.includes("Task #3"));
	assert.ok(container.textContent?.includes("See less"));

	// Click See less to collapse again
	const seeLessBtn = container.querySelector("button[data-history-toggle='true']");
	fireEvent.click(seeLessBtn!);
	assert.ok(!container.textContent?.includes("Task #2"));
	assert.ok(container.textContent?.includes("See more (2 completed)"));
});

test("Folded history honestly reports terminal failures and tool errors", () => {
	const active = makeTask(10, false);
	const failedTask = makeTask(11, true, "failed");
	failedTask.receipt!.isToolError = true;
	const okTasks = [12, 13, 14, 15, 16].map((id) => makeTask(id, true, "completed"));

	const { container } = render(React.createElement(RuntimeGraphTree, {
		tree: [active, failedTask, ...okTasks],
		selectedTaskId: null,
		collapsedTaskIds: new Set(),
		onSelectTask: () => {},
		onToggleCollapse: () => {},
	}));

	const toggle = container.querySelector("button[data-history-toggle='true']");
	assert.ok(toggle, "See more control should exist");
	assert.ok(toggle?.textContent?.includes("See more (1 completed · 1 failed)"));
	assert.equal(toggle?.getAttribute("data-has-failure"), "true");
});

test("Selection retention: selected finished task auto-reveals its branch and stays selected", () => {
	const active = makeTask(10, false);
	const finished1 = makeTask(11, true);
	const finished2 = makeTask(12, true);

	// Select task #12 which is inside finished history
	const { container } = render(React.createElement(RuntimeGraphTree, {
		tree: [active, finished1, finished2],
		selectedTaskId: 12,
		collapsedTaskIds: new Set(),
		onSelectTask: () => {},
		onToggleCollapse: () => {},
	}));

	// Because task #12 is selected, its history branch must be revealed
	assert.ok(container.textContent?.includes("Task #12"));
	const row = container.querySelector("[data-task-id='12'] button[aria-pressed='true']");
	assert.ok(row, "Selected finished task #12 must be rendered and have aria-pressed=true");
});
