import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { TaskTreeItem } from "../../src/ui/runtime-graph/types.ts";

setupDom();
const { render, fireEvent, cleanup } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphNodeRow } = await import("../../src/ui/runtime-graph/node-row.tsx");
const { RuntimeGraphTree } = await import("../../src/ui/runtime-graph/tree.tsx");

test.afterEach(() => {
	cleanup();
});

function makeTask(id: number, isTerminal = true, children: TaskTreeItem[] = []): TaskTreeItem {
	return {
		id, kind: "pi.tool", label: `Task #${id}`, conversationId: 1,
		isTerminal, children,
		receipt: isTerminal ? {
			taskId: id, conversationId: 1, kind: "pi.tool", outcome: "completed",
			isToolError: false, endedAt: 1000 + id, durationMs: 15,
		} : undefined,
		liveNode: !isTerminal ? {
			id, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false,
			state: { status: "running" }, label: `Task #${id}`, startedAt: 1000,
		} : undefined,
	};
}

test("Finding 1 RED: Clicking node-row button or container calls onSelect exactly ONCE", () => {
	let selectCount = 0;
	let collapseCount = 0;
	const item = makeTask(1, true, [makeTask(2, true)]);

	const { container } = render(
		React.createElement(RuntimeGraphNodeRow, {
			item, depth: 0, isSelected: false, isCollapsed: false,
			onSelect: () => { selectCount++; },
			onToggleCollapse: () => { collapseCount++; },
		}),
	);

	const rowBtn = container.querySelector("button[aria-pressed='false']");
	assert.ok(rowBtn, "Task row inner button must exist");

	// 1. Click inner button -> must call onSelect exactly ONCE
	selectCount = 0;
	fireEvent.click(rowBtn!);
	assert.equal(selectCount, 1, `Inner button click must dispatch exactly ONCE, got ${selectCount}`);

	// 2. Click outer div -> must call onSelect exactly ONCE
	selectCount = 0;
	const rowDiv = container.querySelector("div[data-task-id='1']");
	assert.ok(rowDiv, "Row container div must exist");
	fireEvent.click(rowDiv!);
	assert.equal(selectCount, 1, `Row container click must dispatch exactly ONCE, got ${selectCount}`);

	// 3. Chevron button click must toggle collapse and NOT trigger onSelect
	selectCount = 0;
	collapseCount = 0;
	const chevronBtn = container.querySelector("button[aria-label='Collapse']");
	assert.ok(chevronBtn, "Chevron button must exist");
	fireEvent.click(chevronBtn!);
	assert.equal(collapseCount, 1, "Chevron click must call onToggleCollapse");
	assert.equal(selectCount, 0, "Chevron click must NOT call onSelect");
});

test("Finding 2 RED: Nested 1 root + 5 children (total 6) folds behind See more (1 completed)", () => {
	// 1 finished root with 5 finished children = 6 total finished task nodes; preview fills to 5, 1 hidden
	const children = [2, 3, 4, 5, 6].map((id) => makeTask(id, true));
	const tree = [makeTask(1, true, children)];

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree, selectedTaskId: null, collapsedTaskIds: new Set(),
			onSelectTask: () => {}, onToggleCollapse: () => {},
		}),
	);

	const toggleBtn = container.querySelector("button[data-history-toggle='true']");
	assert.ok(toggleBtn, "Group with 6 total finished nodes (1 root + 5 children) MUST fold");
	assert.ok(toggleBtn.textContent?.includes("See more (1 completed)"), `Button must report disjoint hidden count, got: ${toggleBtn.textContent}`);
});

test("Finding 2 RED: 2 roots with 2 children each (total 6) folds behind See more (1 completed)", () => {
	// 2 roots * (1 root + 2 children) = 6 total finished nodes; preview fills to 5, 1 hidden
	const tree = [
		makeTask(1, true, [makeTask(2, true), makeTask(3, true)]),
		makeTask(4, true, [makeTask(5, true), makeTask(6, true)]),
	];

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree, selectedTaskId: null, collapsedTaskIds: new Set(),
			onSelectTask: () => {}, onToggleCollapse: () => {},
		}),
	);

	const toggleBtn = container.querySelector("button[data-history-toggle='true']");
	assert.ok(toggleBtn, "Group with 6 total finished nodes (2 roots + 4 children) MUST fold");
	assert.ok(toggleBtn.textContent?.includes("See more (1 completed)"), `Button must report disjoint hidden count, got: ${toggleBtn.textContent}`);
});

test("Finding 2 RED: Hierarchy with <= 5 total finished nodes stays unfolded with no disclosure button", () => {
	// 1 root with 4 children = 5 total nodes (boundary <= 5)
	const children = [2, 3, 4, 5].map((id) => makeTask(id, true));
	const tree5 = [makeTask(1, true, children)];

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: tree5, selectedTaskId: null, collapsedTaskIds: new Set(),
			onSelectTask: () => {}, onToggleCollapse: () => {},
		}),
	);

	const toggleBtn = container.querySelector("button[data-history-toggle='true']");
	assert.equal(toggleBtn === null, true, "5 total finished nodes must NOT have See more button");
	assert.equal(container.querySelectorAll("[data-task-id]").length, 5, "All 5 nodes must be directly visible");
});

test("Finding 2 RED: Terminal ancestor with live child remains visible in active branch", () => {
	// Terminal root with running live child
	const activeChild = makeTask(2, false);
	const tree = [makeTask(1, true, [activeChild])];

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree, selectedTaskId: null, collapsedTaskIds: new Set(),
			onSelectTask: () => {}, onToggleCollapse: () => {},
		}),
	);

	const rootNode = container.querySelector("[data-task-id='1']");
	assert.ok(rootNode, "Terminal ancestor with active child must be visible");
	const childNode = container.querySelector("[data-task-id='2']");
	assert.ok(childNode, "Active child must be visible");
	assert.equal(container.querySelector("button[data-history-toggle='true']") === null, true, "No folding button");
});
