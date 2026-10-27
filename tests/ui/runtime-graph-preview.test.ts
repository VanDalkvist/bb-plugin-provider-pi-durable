import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import { makeTask } from "./runtime-graph-test-fixtures.ts";

setupDom();
const { render } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphTree } = await import("../../src/ui/runtime-graph/tree.tsx");

test("Preview: 0 active + 100 finished -> 5 visible + 95 hidden under See more (95 completed)", () => {
	const tasks = Array.from({ length: 100 }, (_, i) => makeTask(i + 1, true, "completed"));

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: tasks,
			selectedTaskId: null,
			collapsedTaskIds: new Set(),
			onSelectTask: () => {},
			onToggleCollapse: () => {},
		}),
	);

	const visibleRows = container.querySelectorAll("[data-task-id]");
	assert.equal(visibleRows.length, 5, "Must render exactly 5 visible rows in preview");
	assert.ok(container.textContent?.includes("Task #1"));
	assert.ok(container.textContent?.includes("Task #5"));
	assert.ok(!container.textContent?.includes("Task #6"));

	const seeMore = container.querySelector("button[data-history-toggle='true']");
	assert.ok(seeMore, "See more button must exist");
	assert.ok(
		seeMore?.textContent?.includes("See more (95 completed)"),
		`Expected 'See more (95 completed)', got: ${seeMore?.textContent}`,
	);
});

test("Preview: 2 active + 100 finished -> 2 + 3 visible (5 total) + 97 hidden", () => {
	const active = [makeTask(1, false), makeTask(2, false)];
	const finished = Array.from({ length: 100 }, (_, i) => makeTask(10 + i, true, "completed"));

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: [...active, ...finished],
			selectedTaskId: null,
			collapsedTaskIds: new Set(),
			onSelectTask: () => {},
			onToggleCollapse: () => {},
		}),
	);

	const visibleRows = container.querySelectorAll("[data-task-id]");
	assert.equal(visibleRows.length, 5, "Must render 2 active + 3 finished = 5 visible rows");
	assert.ok(container.textContent?.includes("Task #1"));
	assert.ok(container.textContent?.includes("Task #2"));
	assert.ok(container.textContent?.includes("Task #10"));
	assert.ok(container.textContent?.includes("Task #12"));
	assert.ok(!container.textContent?.includes("Task #13"));

	const seeMore = container.querySelector("button[data-history-toggle='true']");
	assert.ok(seeMore?.textContent?.includes("See more (97 completed)"));
});

test("Preview: 5 active -> no finished filler, all 5 active visible", () => {
	const active = [1, 2, 3, 4, 5].map((id) => makeTask(id, false));
	const finished = [6, 7, 8, 9, 10, 11].map((id) => makeTask(id, true, "completed"));

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: [...active, ...finished],
			selectedTaskId: null,
			collapsedTaskIds: new Set(),
			onSelectTask: () => {},
			onToggleCollapse: () => {},
		}),
	);

	const visibleRows = container.querySelectorAll("[data-task-id]");
	assert.equal(visibleRows.length, 5, "5 active -> exactly 5 rows visible, no finished filler");
	assert.ok(!container.textContent?.includes("Task #6"));

	const seeMore = container.querySelector("button[data-history-toggle='true']");
	assert.ok(seeMore?.textContent?.includes("See more (6 completed)"));
});

test("Preview: >5 active -> all active stay visible, never hide active tasks", () => {
	const active = [1, 2, 3, 4, 5, 6, 7].map((id) => makeTask(id, false));
	const finished = [8, 9, 10].map((id) => makeTask(id, true, "completed"));

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: [...active, ...finished],
			selectedTaskId: null,
			collapsedTaskIds: new Set(),
			onSelectTask: () => {},
			onToggleCollapse: () => {},
		}),
	);

	const visibleRows = container.querySelectorAll("[data-task-id]");
	assert.equal(visibleRows.length, 7, "All 7 active tasks must remain visible");
	assert.ok(!container.textContent?.includes("Task #8"));

	const seeMore = container.querySelector("button[data-history-toggle='true']");
	assert.ok(seeMore?.textContent?.includes("See more (3 completed)"));
});

test("Preview: Small total <= 5 shows all without control", () => {
	const tasks = [1, 2, 3, 4, 5].map((id) => makeTask(id, true, "completed"));

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: tasks,
			selectedTaskId: null,
			collapsedTaskIds: new Set(),
			onSelectTask: () => {},
			onToggleCollapse: () => {},
		}),
	);

	assert.equal(container.querySelectorAll("[data-task-id]").length, 5);
	assert.equal(container.querySelector("button[data-history-toggle='true']") === null, true);
});
