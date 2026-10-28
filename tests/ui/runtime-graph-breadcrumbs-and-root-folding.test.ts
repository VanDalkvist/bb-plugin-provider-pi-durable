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

test.afterEach(() => {
	cleanup();
});

function makeTask(
	id: number, kind: string, label: string, isTerminal = true,
	children: TaskTreeItem[] = [], toolName?: string, targetHint?: string,
): TaskTreeItem {
	return {
		id, kind, label, conversationId: 1, isTerminal, children,
		receipt: isTerminal ? {
			taskId: id, conversationId: 1, kind, outcome: "completed", isToolError: false,
			toolName, targetHint, endedAt: 2000 + id, durationMs: 120,
		} : undefined,
		liveNode: !isTerminal ? {
			id, kind, conversationId: 1, background: false, abortRequested: false,
			state: { status: "running" }, label, toolName, targetHint, startedAt: 1000,
		} : undefined,
	};
}

test("Cycle 82: pi.generation with 1 tool child renders as 1-line breadcrumb without chevron", () => {
	const toolChild = makeTask(68, "pi.tool", "pi.tool", true, [], "read", "src/foo.ts");
	const generation = makeTask(67, "pi.generation", "pi.generation #67", true, [toolChild]);

	let selectedId: number | null = null;
	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: [generation],
			selectedTaskId: selectedId,
			collapsedTaskIds: new Set(),
			onSelectTask: (id) => { selectedId = id; },
			onToggleCollapse: () => {},
		}),
	);

	// Exactly 1 row in the DOM (no nested child row)
	const rows = container.querySelectorAll("div[data-task-id]");
	assert.equal(rows.length, 1, "Must render exactly 1 row for generation + single tool");

	// Row has no chevron button (spacer instead)
	const chevronBtn = container.querySelector("button[aria-expanded]");
	assert.equal(chevronBtn, null, "Single-child generation must NOT have a collapse chevron");

	// Contains breadcrumbs separator and both labels
	assert.ok(container.textContent?.includes("pi.generation #67"));
	assert.ok(container.textContent?.includes("›"));
	assert.ok(container.textContent?.includes("read: src/foo.ts"));

	// No See more button
	const toggleBtn = container.querySelector("button[data-history-toggle='true']");
	assert.equal(toggleBtn, null, "No See more button on single-child turn");

	// Clicking child segment selects child task #68
	const childSpan = container.querySelector("[data-task-id='68']");
	assert.ok(childSpan, "Child segment with data-task-id=68 must exist");
	fireEvent.click(childSpan!);
	assert.equal(selectedId, 68, "Clicking child segment must select child tool task");

	// Clicking parent segment selects parent task #67
	const parentSpan = container.querySelector("span[title='pi.generation #67']");
	assert.ok(parentSpan, "Parent segment with title must exist");
	fireEvent.click(parentSpan!);
	assert.equal(selectedId, 67, "Clicking parent segment must select parent generation task");
});

test("Cycle 82: Multi-child generation renders with chevron and (N tasks), collapsed by default into 1 line", () => {
	const tool1 = makeTask(71, "pi.tool", "read: file1.ts", true);
	const tool2 = makeTask(72, "pi.tool", "write: file2.ts", true);
	const generation = makeTask(70, "pi.generation", "pi.generation #70", true, [tool1, tool2]);

	let toggledId: number | null = null;
	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: [generation],
			selectedTaskId: null,
			collapsedTaskIds: new Set(),
			onSelectTask: () => {},
			onToggleCollapse: (id) => { toggledId = id; },
		}),
	);

	// Multi-child item has chevron button
	const chevronBtn = container.querySelector("button[aria-expanded]") as HTMLButtonElement;
	assert.ok(chevronBtn, "Multi-child generation must have a chevron button");
	assert.equal(chevronBtn.getAttribute("aria-expanded"), "false", "Must be collapsed by default");

	// Shows count hint
	assert.ok(container.textContent?.includes("(2 tasks)"), "Must display (2 tasks) hint");

	// When collapsed, only the parent row is visible
	const rows = container.querySelectorAll("[data-task-id]");
	assert.equal(rows.length, 1, "Only parent row visible when collapsed");

	// Clicking chevron calls toggleCollapse
	fireEvent.click(chevronBtn);
	assert.equal(toggledId, 70, "Clicking chevron must toggle collapse for task #70");
});

test("Cycle 82: Multi-child generation with active work is expanded by default", () => {
	const activeTool = makeTask(81, "pi.tool", "bash: make test", false);
	const finishedTool = makeTask(82, "pi.tool", "read: config.json", true);
	const generation = makeTask(80, "pi.generation", "pi.generation #80", false, [activeTool, finishedTool]);

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: [generation],
			selectedTaskId: null,
			collapsedTaskIds: new Set(),
			onSelectTask: () => {},
			onToggleCollapse: () => {},
		}),
	);

	const chevronBtn = container.querySelector("button[aria-expanded]") as HTMLButtonElement;
	assert.ok(chevronBtn, "Multi-child generation must have a chevron button");
	assert.equal(chevronBtn.getAttribute("aria-expanded"), "true", "Active multi-child must be expanded by default");

	// Both child rows are visible
	assert.ok(container.querySelector("[data-task-id='81']"), "Active child must be visible");
	assert.ok(container.querySelector("[data-task-id='82']"), "Sibling child must be visible");
});

test("Cycle 82: Root list with > 5 tasks folds behind See more at the bottom and toggles with See less", () => {
	const turns = Array.from({ length: 8 }, (_, i) => {
		const tool = makeTask(100 + i * 2 + 1, "pi.tool", `tool #${i + 1}`, true);
		return makeTask(100 + i * 2, "pi.generation", `turn #${i + 1}`, true, [tool]);
	});

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: turns,
			selectedTaskId: null,
			collapsedTaskIds: new Set(),
			onSelectTask: () => {},
			onToggleCollapse: () => {},
		}),
	);

	// By default, exactly 5 rows visible (each turn is 1 line breadcrumb)
	const rows = container.querySelectorAll("[data-task-id]");
	// Note: each breadcrumb row has data-task-id for outer row and data-task-id for child segment
	const outerRows = container.querySelectorAll("div[data-task-id]");
	assert.equal(outerRows.length, 5, "Must render exactly 5 root turns initially");

	// Toggle button at the bottom of the root list
	const toggleBtn = container.querySelector("button[data-history-toggle='true']");
	assert.ok(toggleBtn, "Root toggle button must exist at the bottom");
	assert.ok(toggleBtn.textContent?.includes("See more (6 completed)"), `Expected 'See more (6 completed)', got: ${toggleBtn.textContent}`);

	// Click See more -> expands all 8 turns
	fireEvent.click(toggleBtn);
	const expandedRows = container.querySelectorAll("div[data-task-id]");
	assert.equal(expandedRows.length, 8, "All 8 root turns visible after expanding");

	// Button becomes See less
	const seeLessBtn = container.querySelector("button[data-history-toggle='true']");
	assert.ok(seeLessBtn?.textContent?.includes("See less"), "Button text toggles to See less");

	// Click See less -> collapses back to 5 turns
	fireEvent.click(seeLessBtn!);
	const collapsedAgain = container.querySelectorAll("div[data-task-id]");
	assert.equal(collapsedAgain.length, 5, "Collapsed back to 5 root turns");
});
