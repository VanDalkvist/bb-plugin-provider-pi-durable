import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { RuntimeGraphSnapshot } from "../../src/runtime-graph/types.ts";

setupDom();
const { render, fireEvent } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphSegmentDetails } = await import("../../src/ui/runtime-graph/segment.tsx");
const { RuntimeGraphDetails } = await import("../../src/ui/runtime-graph/details.tsx");

function createMockSnapshot(): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "s-1", rootConversationId: "1", buildId: "b-1" },
		observation: { epoch: "ep-1", revision: 1, observedAt: 1000, completeness: "complete" },
		nodes: {
			"10": { id: 10, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false, state: { status: "running" }, label: "Running Tool" },
			"11": { id: 11, kind: "bash", conversationId: 1, owner: 10, background: false, abortRequested: false, state: { status: "waiting", on: [10], policy: "all" }, label: "Waiting Child" },
		},
		conversations: { "1": { id: 1 } }, receipts: [], stats: { liveCount: 2, terminalCount: 0, totalCount: 2 },
	};
}

test("Conditional Inspector: inspector is NOT mounted when selectedTaskId is null", () => {
	const snapshot = createMockSnapshot();
	const state: any = {
		threadId: "thr-1", status: "ok", snapshot,
		tree: [{ id: 10, kind: "pi.tool", label: "Running Tool", conversationId: 1, isTerminal: false, liveNode: snapshot.nodes["10"], children: [] }],
		selectedTaskId: null, selectedItem: null, collapsedTaskIds: new Set(), selectTask: () => {}, toggleCollapse: () => {},
	};

	const { container } = render(React.createElement(RuntimeGraphSegmentDetails, {
		threadId: "thr-1", projectId: "p-1", environment: null, segments: [], isExpanded: true, onToggle: () => {}, testState: state,
	}));
	assert.ok(container.textContent?.includes("Running Tool"));
	assert.ok(!container.textContent?.includes("Task ID"));
	assert.equal(container.querySelector("[data-testid='runtime-graph-inspector']"), null);
});

test("Conditional Inspector: inspector mounts on explicit selection and can be closed", () => {
	const snapshot = createMockSnapshot();
	let selectedId: number | null = 10;
	const mockItem: any = {
		id: 10, kind: "pi.tool", label: "Running Tool", conversationId: 1,
		isTerminal: false, liveNode: snapshot.nodes["10"], children: [],
	};

	const state: any = {
		threadId: "thr-1", status: "ok", snapshot,
		tree: [mockItem],
		selectedTaskId: selectedId,
		selectedItem: mockItem,
		collapsedTaskIds: new Set(),
		selectTask: (id: number | null) => { selectedId = id; },
		toggleCollapse: () => {},
	};

	const { container } = render(
		React.createElement(RuntimeGraphSegmentDetails, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: true, onToggle: () => {}, testState: state,
		}),
	);

	// Inspector must be mounted
	const inspector = container.querySelector("[data-testid='runtime-graph-inspector']");
	assert.ok(inspector, "Inspector must be mounted when task is selected");
	assert.ok(container.textContent?.includes("Task ID"));
	assert.ok(container.textContent?.includes("#10"));

	// Close / deselect button should exist and work
	const closeBtn = (container.querySelector("button[aria-label='Close task details']") ??
		container.querySelector("button[aria-label='Close inspector']")) as HTMLButtonElement;
	assert.ok(closeBtn, "Close inspector button must be present");
	fireEvent.click(closeBtn);
	assert.equal(selectedId, null, "Clicking close must deselect task (set to null)");
});

test("Conditional Inspector: chevron click toggles collapse and does NOT select task", () => {
	const snapshot = createMockSnapshot();
	let selectedId: number | null = null;
	let toggledId: number | null = null;

	const childItem: any = {
		id: 11, kind: "bash", label: "Waiting Child", conversationId: 1,
		ownerId: 10, isTerminal: false, liveNode: snapshot.nodes["11"], children: [],
	};
	const parentItem: any = {
		id: 10, kind: "pi.tool", label: "Running Tool", conversationId: 1,
		isTerminal: false, liveNode: snapshot.nodes["10"], children: [childItem],
	};

	const state: any = {
		threadId: "thr-1", status: "ok", snapshot,
		tree: [parentItem],
		selectedTaskId: selectedId,
		selectedItem: null,
		collapsedTaskIds: new Set(),
		selectTask: (id: number | null) => { selectedId = id; },
		toggleCollapse: (id: number) => { toggledId = id; },
	};

	const { container } = render(
		React.createElement(RuntimeGraphSegmentDetails, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: true, onToggle: () => {}, testState: state,
		}),
	);

	// Find the chevron button (has aria-expanded)
	const chevronBtn = container.querySelector("button[aria-expanded]") as HTMLButtonElement;
	assert.ok(chevronBtn, "Chevron button must exist");

	fireEvent.click(chevronBtn);
	assert.equal(toggledId, 10, "Chevron click must toggle collapse");
	assert.equal(selectedId, null, "Chevron click must NOT select task");
});

test("Conditional Inspector: selectedItem missing from tree unmounts inspector", () => {
	const snapshot = createMockSnapshot();
	// selectedTaskId is 99 (pruned), but selectedItem is null
	const state: any = {
		threadId: "thr-1", status: "ok", snapshot,
		tree: [
			{
				id: 10, kind: "pi.tool", label: "Running Tool", conversationId: 1,
				isTerminal: false, liveNode: snapshot.nodes["10"], children: [],
			},
		],
		selectedTaskId: 99,
		selectedItem: null,
		collapsedTaskIds: new Set(),
		selectTask: () => {},
		toggleCollapse: () => {},
	};

	const { container } = render(
		React.createElement(RuntimeGraphSegmentDetails, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: true, onToggle: () => {}, testState: state,
		}),
	);

	const inspector = container.querySelector("[data-testid='runtime-graph-inspector']");
	assert.equal(inspector, null, "Inspector must NOT be mounted when selectedItem is null");
});

test("Conditional Inspector: keyboard Enter and Space selects task", () => {
	const snapshot = createMockSnapshot();
	const selectedIds: (number | null)[] = [];
	const mockItem: any = {
		id: 10, kind: "pi.tool", label: "Running Tool", conversationId: 1,
		isTerminal: false, liveNode: snapshot.nodes["10"], children: [],
	};

	const state: any = {
		threadId: "thr-1", status: "ok", snapshot,
		tree: [mockItem],
		selectedTaskId: null,
		selectedItem: null,
		collapsedTaskIds: new Set(),
		selectTask: (id: number | null) => { selectedIds.push(id); },
		toggleCollapse: () => {},
	};

	const { container } = render(
		React.createElement(RuntimeGraphSegmentDetails, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: true, onToggle: () => {}, testState: state,
		}),
	);

	const taskRowBtn = container.querySelector("div[data-task-id='10'] button[aria-pressed]") as HTMLButtonElement;
	assert.ok(taskRowBtn, "Task row button must exist");

	// Test Enter key
	fireEvent.keyDown(taskRowBtn, { key: "Enter" });
	assert.deepEqual(selectedIds, [10], "Enter key must trigger selection");

	// Test Space key
	fireEvent.keyDown(taskRowBtn, { key: " " });
	assert.deepEqual(selectedIds, [10, 10], "Space key must trigger selection");
});
