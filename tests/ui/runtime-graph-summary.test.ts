import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { RuntimeGraphSnapshot } from "../../src/runtime-graph/types.ts";

setupDom();
const { render, fireEvent } = await import("@testing-library/react");
const { loadPluginApp, installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphSummary } = await import("../../src/ui/runtime-graph/summary.tsx");
const appModule = await import("../../app.tsx");

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

test("app.tsx registers experimental_threadContextSegment slot with runtime-graph id", async () => {
	const captured = await loadPluginApp(appModule);

	assert.equal(captured.threadContextSegments.length, 1);
	const segment = captured.threadContextSegments[0];
	assert.equal(segment.id, "runtime-graph");
	assert.equal(segment.title, "Execution Progress");
	assert.equal(segment.group, "2_runtime");
	assert.equal(typeof segment.summary, "function");
	assert.equal(typeof segment.details, "function");
	assert.equal(typeof segment.useVisible, "function");
});

test("RuntimeGraphSummary: renders status, counters, and handles onToggle", () => {
	let toggled = false;
	const snapshot = createMockSnapshot();
	const state: any = {
		threadId: "thr-1", status: "ok", snapshot, tree: [],
		selectedTaskId: null, selectedItem: null, collapsedTaskIds: new Set(),
		selectTask: () => {}, toggleCollapse: () => {},
	};

	const { container } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "proj-1", environment: null,
			segments: [], isExpanded: false, onToggle: () => { toggled = true; },
			testState: state,
		}),
	);

	assert.ok(container.textContent?.includes("Execution Progress"));
	assert.ok(container.textContent?.includes("2 active tasks"));
	assert.ok(container.textContent?.includes("1 waiting"));

	const btn = container.querySelector("button");
	assert.ok(btn);
	fireEvent.click(btn!);
	assert.equal(toggled, true);
});

test("RuntimeGraphSummary: displays limited badge when completeness is limited", () => {
	const snapshot = createMockSnapshot({
		observation: { epoch: "epoch-1", revision: 1, observedAt: 1000, completeness: "limited" },
	});
	const state: any = {
		threadId: "thr-1", status: "ok", snapshot, tree: [],
		selectedTaskId: null, selectedItem: null, collapsedTaskIds: new Set(),
		selectTask: () => {}, toggleCollapse: () => {},
	};

	const { container } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "proj-1", environment: null,
			segments: [], isExpanded: false, onToggle: () => {},
			testState: state,
		}),
	);

	assert.ok(container.textContent?.includes("Limited"));
});
