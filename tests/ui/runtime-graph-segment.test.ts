import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { RuntimeGraphSnapshot } from "../../src/runtime-graph/types.ts";

setupDom();
const { render } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphSegmentDetails } = await import("../../src/ui/runtime-graph/segment.tsx");

function createMockSnapshot(overrides?: Partial<RuntimeGraphSnapshot>): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "session-1", rootConversationId: "1", buildId: "build-1" },
		observation: { epoch: "epoch-1", revision: 1, observedAt: 1000, completeness: "complete" },
		nodes: {
			"10": {
				id: 10, kind: "pi.generation", conversationId: 1,
				background: false, abortRequested: false,
				state: { status: "running", phase: "generating" }, label: "Root Generation",
			},
			"11": {
				id: 11, kind: "bash", conversationId: 1, owner: 10,
				background: false, abortRequested: false,
				state: { status: "waiting", on: [42], policy: "allSettled" }, label: "bash: npm test",
			},
		},
		conversations: { "1": { id: 1 } },
		receipts: [
			{
				taskId: 9, conversationId: 1, kind: "read", outcome: "completed",
				isToolError: true, endedAt: 900, durationMs: 45, preview: "Error reading file",
			},
		],
		stats: { liveCount: 2, terminalCount: 1, totalCount: 3 },
		...overrides,
	};
}

test("RuntimeGraphSegmentDetails: returns null when isExpanded is false", () => {
	const snapshot = createMockSnapshot();
	const state: any = {
		threadId: "thr-1", status: "ok", snapshot, tree: [],
		selectedTaskId: null, selectedItem: null, collapsedTaskIds: new Set(),
		selectTask: () => {}, toggleCollapse: () => {},
	};

	const { container } = render(
		React.createElement(RuntimeGraphSegmentDetails, {
			threadId: "thr-1", projectId: "proj-1", environment: null,
			segments: [], isExpanded: false, onToggle: () => {}, testState: state,
		}),
	);

	assert.equal(container.innerHTML, "");
});

test("RuntimeGraphSegmentDetails: renders tree and inspector when isExpanded is true", () => {
	const snapshot = createMockSnapshot();
	let selectedId: number | null = 11;

	const mockItem: any = {
		id: 11, kind: "bash", label: "bash: npm test",
		conversationId: 1, ownerId: 10, isTerminal: false,
		waitingOn: [42], liveNode: snapshot.nodes["11"], children: [],
	};

	const state: any = {
		threadId: "thr-1", status: "ok", snapshot,
		tree: [
			{
				id: 10, kind: "pi.generation", label: "Root Generation",
				conversationId: 1, isTerminal: false,
				liveNode: snapshot.nodes["10"], children: [mockItem],
			},
		],
		selectedTaskId: selectedId, selectedItem: mockItem,
		collapsedTaskIds: new Set(),
		selectTask: (id: number) => { selectedId = id; }, toggleCollapse: () => {},
	};

	const { container } = render(
		React.createElement(RuntimeGraphSegmentDetails, {
			threadId: "thr-1", projectId: "proj-1", environment: null,
			segments: [], isExpanded: true, onToggle: () => {}, testState: state,
		}),
	);

	assert.ok(container.textContent?.includes("Root Generation"));
	assert.ok(container.textContent?.includes("bash: npm test"));
	assert.ok(container.textContent?.includes("#11"));
	assert.ok(container.textContent?.includes("Waiting") || container.textContent?.includes("waits: #42"));
	assert.ok(container.textContent?.includes("#42"));

	const layoutEl = container.querySelector("[data-layout]");
	assert.ok(layoutEl, "Must have data-layout attribute for responsive inspection");
	assert.ok(layoutEl.getAttribute("data-layout") === "wide" || layoutEl.getAttribute("data-layout") === "narrow");
});

test("RuntimeGraphSegmentDetails: supports narrow layout responsive mode (D5)", () => {
	const snapshot = createMockSnapshot();
	const state: any = {
		threadId: "thr-1", status: "ok", snapshot, tree: [],
		selectedTaskId: null, selectedItem: null, collapsedTaskIds: new Set(),
		selectTask: () => {}, toggleCollapse: () => {},
	};

	const { container } = render(
		React.createElement(RuntimeGraphSegmentDetails, {
			threadId: "thr-1", projectId: "proj-1", environment: null,
			segments: [], isExpanded: true, onToggle: () => {}, testState: state,
		}),
	);

	const layoutEl = container.querySelector("[data-layout]");
	assert.ok(layoutEl, "Must render layout container");
	assert.ok(layoutEl.className.includes("overflow-hidden"), "Must contain bounded scroll region");
});
