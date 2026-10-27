import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";

setupDom();
const { render } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphSummary } = await import("../../src/ui/runtime-graph/summary.tsx");
const { RuntimeGraphTree } = await import("../../src/ui/runtime-graph/tree.tsx");
const { RuntimeGraphDetails } = await import("../../src/ui/runtime-graph/details.tsx");

test("English UI: Summary displays English title, states, and singular/plural counters", () => {
	const makeState = (active: number, waiting = 0): any => ({
		threadId: "thr-1", status: "ok",
		snapshot: {
			version: 1, scope: { sessionId: "s", rootConversationId: "1", buildId: "b" },
			observation: { epoch: "e", revision: 1, observedAt: 1000, completeness: "complete" },
			nodes: active === 1
				? { "1": { id: 1, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false, state: { status: "running" } } }
				: {
					"1": { id: 1, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false, state: { status: "running" } },
					"2": { id: 2, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false, state: { status: "waiting", on: [1] } },
				},
			conversations: { "1": { id: 1 } }, receipts: [],
			stats: { liveCount: active, terminalCount: 0, totalCount: active },
		},
		tree: [], selectedTaskId: null, selectedItem: null,
		collapsedTaskIds: new Set(), selectTask: () => {}, toggleCollapse: () => {},
	});

	// Test 1 active task (singular)
	const { container: c1 } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: false, onToggle: () => {}, testState: makeState(1),
		}),
	);
	assert.ok(c1.textContent?.includes("Execution Progress"), "Summary title must be in English");
	assert.ok(c1.textContent?.includes("1 active task"), `Expected '1 active task', got ${c1.textContent}`);
	assert.ok(!c1.textContent?.includes("активн"), "Must not contain Russian word 'активн'");

	// Test 2 active tasks (plural)
	const { container: c2 } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: false, onToggle: () => {}, testState: makeState(2, 1),
		}),
	);
	assert.ok(c2.textContent?.includes("2 active tasks"), `Expected '2 active tasks', got ${c2.textContent}`);
	assert.ok(c2.textContent?.includes("1 waiting"), `Expected '1 waiting', got ${c2.textContent}`);

	// Test empty state
	const emptyState: any = {
		threadId: "thr-1", status: "ok", snapshot: null, tree: [],
		selectedTaskId: null, selectedItem: null, collapsedTaskIds: new Set(),
		selectTask: () => {}, toggleCollapse: () => {},
	};
	const { container: cEmpty } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: false, onToggle: () => {}, testState: emptyState,
		}),
	);
	assert.ok(cEmpty.textContent?.includes("No active tasks"), "Empty state must be in English");

	// Test unavailable state
	const unavailState: any = { ...emptyState, status: "unavailable" };
	const { container: cUnavail } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: false, onToggle: () => {}, testState: unavailState,
		}),
	);
	assert.ok(cUnavail.textContent?.includes("Task graph unavailable"), "Unavailable state must be in English");
});

test("English UI: Tree renders English empty state", () => {
	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: [], selectedTaskId: null, collapsedTaskIds: new Set(),
			onSelectTask: () => {}, onToggleCollapse: () => {},
		}),
	);
	assert.ok(container.textContent?.includes("No tasks in graph"));
	assert.ok(!container.textContent?.includes("Нет задач"));
});

test("English UI: Details inspector renders English labels and root placeholder", () => {
	const item: any = {
		id: 5, kind: "pi.tool", conversationId: 1, ownerId: undefined,
		label: "pi.tool: test", isTerminal: false, children: [],
		liveNode: { id: 5, state: { status: "running", phase: "execution" }, durationMs: 120 },
	};

	const { container } = render(React.createElement(RuntimeGraphDetails, { selectedItem: item }));
	assert.ok(container.textContent?.includes("Task #5"));
	assert.ok(container.textContent?.includes("Task ID"));
	assert.ok(container.textContent?.includes("Task type"));
	assert.ok(container.textContent?.includes("Conversation"));
	assert.ok(container.textContent?.includes("Owner"));
	assert.ok(container.textContent?.includes("— (root)"));
	assert.ok(container.textContent?.includes("Runtime status"));
	assert.ok(container.textContent?.includes("Execution phase"));
	assert.ok(container.textContent?.includes("Duration"));
	assert.ok(container.textContent?.includes("120 ms"));
	assert.ok(!container.textContent?.includes("Задача #"));
	assert.ok(!container.textContent?.includes("ID задачи"));
	assert.ok(!container.textContent?.includes("корневая"));
});
