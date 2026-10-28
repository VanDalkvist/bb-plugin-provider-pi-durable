import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { TaskTreeItem } from "../../src/ui/runtime-graph/types.ts";

setupDom();
const { render, cleanup } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphTree } = await import("../../src/ui/runtime-graph/tree.tsx");
const { RuntimeGraphDetails } = await import("../../src/ui/runtime-graph/details.tsx");
const { RuntimeGraphSegmentDetails } = await import("../../src/ui/runtime-graph/segment.tsx");
const { findSubagentMeta, buildMappedNode } = await import("../../src/runner/runtime-graph-mapper.ts");
const { TaskNames } = await import("../../src/runner/task-labels.ts");

test.afterEach(() => {
	cleanup();
});

test("Cycle 83: Subagent Anchor with active child shows Running icon (Play) and live timer, NOT green Check 1ms", () => {
	const activeTurn: TaskTreeItem = {
		id: 467, kind: "assistant turn", label: "assistant turn", conversationId: 2, ownerId: 466, isTerminal: false, children: [],
		liveNode: { id: 467, kind: "pi.generation", conversationId: 2, background: false, abortRequested: false, state: { status: "running" }, label: "assistant turn", startedAt: 1000 },
	};
	const anchor: TaskTreeItem = {
		id: 466, kind: "bb.subagent-anchor", label: "bb.subagent-anchor · subagent: Architectural Reviewer",
		conversationId: 1, isTerminal: true, children: [activeTurn],
		receipt: { taskId: 466, conversationId: 1, kind: "bb.subagent-anchor", outcome: "completed", isToolError: false, endedAt: 2000, durationMs: 1, startedAt: 1000, toolName: "subagent", targetHint: "Architectural Reviewer", preview: "Audit the changes made in Cycle 82" },
	};

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: [anchor], selectedTaskId: null, collapsedTaskIds: new Set(), now: 11000, onSelectTask: () => {}, onToggleCollapse: () => {},
		}),
	);

	const anchorRow = container.querySelector("div[data-task-id='466']");
	assert.ok(anchorRow, "Anchor row must exist");
	assert.equal(anchorRow.getAttribute("data-active"), "true", "Active child work must bubble up data-active");
	assert.ok(container.innerHTML.includes("Play"), "Must render Play icon while child work is running");
	assert.ok(container.innerHTML.includes("text-blue-500"), "Must use blue color class");
	assert.ok(!anchorRow.innerHTML.includes("text-green-500"), "Must NOT render green completed icon while active");
	assert.ok(container.textContent?.includes("10.0s"), "Must display live elapsed duration instead of 1ms");
	assert.ok(!container.textContent?.includes("1ms"), "Must NOT display 1ms while child is active");
});

test("Cycle 83: Subagent Anchor switches to completed Check only when all children finish", () => {
	const finishedTurn: TaskTreeItem = {
		id: 467, kind: "assistant turn", label: "assistant turn", conversationId: 2, ownerId: 466, isTerminal: true, children: [],
		receipt: { taskId: 467, conversationId: 2, kind: "pi.generation", outcome: "completed", isToolError: false, endedAt: 5000, durationMs: 4000, startedAt: 1000 },
	};
	const anchor: TaskTreeItem = {
		id: 466, kind: "bb.subagent-anchor", label: "bb.subagent-anchor · subagent: Architectural Reviewer",
		conversationId: 1, isTerminal: true, children: [finishedTurn],
		receipt: { taskId: 466, conversationId: 1, kind: "bb.subagent-anchor", outcome: "completed", isToolError: false, endedAt: 5000, durationMs: 4000, startedAt: 1000, toolName: "subagent", targetHint: "Architectural Reviewer" },
	};

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: [anchor], selectedTaskId: null, collapsedTaskIds: new Set([466]), onSelectTask: () => {}, onToggleCollapse: () => {},
		}),
	);

	const anchorRow = container.querySelector("div[data-task-id='466']");
	assert.ok(anchorRow);
	assert.equal(anchorRow.getAttribute("data-active"), null, "Completed work must not have data-active");
	assert.ok(anchorRow.innerHTML.includes("Check"), "Completed work renders Check icon");
	assert.ok(anchorRow.innerHTML.includes("text-green-500"), "Completed work uses green icon");
});

test("Cycle 83: Details inspector renders subagent task in dedicated scrollable box and fixed header", () => {
	const activeChild: TaskTreeItem = {
		id: 467, kind: "assistant turn", label: "assistant turn", conversationId: 2, ownerId: 466, isTerminal: false, children: [],
		liveNode: { id: 467, kind: "pi.generation", conversationId: 2, background: false, abortRequested: false, state: { status: "running" }, label: "assistant turn", startedAt: 1000 },
	};
	const anchor: TaskTreeItem = {
		id: 466, kind: "bb.subagent-anchor", label: "bb.subagent-anchor · subagent: Product Reviewer",
		conversationId: 1, isTerminal: true, children: [activeChild],
		receipt: { taskId: 466, conversationId: 1, kind: "bb.subagent-anchor", outcome: "completed", isToolError: false, endedAt: 2000, durationMs: 1, startedAt: 1000, toolName: "subagent", targetHint: "Product Reviewer", preview: "Audit the product scenarios and verify breadcrumbs" },
	};

	const { container } = render(
		React.createElement(RuntimeGraphDetails, { selectedItem: anchor, now: 15000, onClose: () => {} }),
	);

	const header = container.querySelector(".flex-shrink-0.border-b");
	assert.ok(header, "Header must be flex-shrink-0 and border-b");
	assert.ok(container.textContent?.includes("Running in background"), "Must display Running in background");
	assert.ok(!container.textContent?.includes("Completed successfully"), "Must NOT display Completed successfully while active");
	assert.ok(container.textContent?.includes("Subagent task"), "Must have Subagent task section");
	assert.ok(container.textContent?.includes("Audit the product scenarios and verify breadcrumbs"), "Must display subagent task content");
});

test("Cycle 83: Segment details maintains stable max-h-64 and balanced w-72 max-w-[45%]", () => {
	const snapshot: any = { nodes: {}, receipts: [], stats: { liveCount: 0, terminalCount: 0, totalCount: 0 }, conversations: {} };
	const state: any = {
		threadId: "thr-1", status: "ok", snapshot,
		tree: [], selectedTaskId: null, selectedItem: null,
		collapsedTaskIds: new Set(), selectTask: () => {}, toggleCollapse: () => {},
	};

	// 1. Without selection
	const { container: cNoSelect } = render(
		React.createElement(RuntimeGraphSegmentDetails, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: true, onToggle: () => {}, testState: state,
		}),
	);
	const rootDivNoSelect = cNoSelect.querySelector("div[data-layout]");
	assert.ok(rootDivNoSelect?.className.includes("max-h-64"), "Root container must use stable max-h-64");

	// 2. With selection
	const item: TaskTreeItem = {
		id: 1, kind: "pi.tool", label: "read: foo.ts", conversationId: 1, isTerminal: true, children: [],
	};
	const selectedState = { ...state, selectedTaskId: 1, selectedItem: item };
	cleanup();

	const { container: cSelected } = render(
		React.createElement(RuntimeGraphSegmentDetails, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: true, onToggle: () => {}, testState: selectedState,
		}),
	);
	const rootDivSelected = cSelected.querySelector("div[data-layout]");
	assert.ok(rootDivSelected?.className.includes("max-h-64"), "Selected container must retain same max-h-64");
	const inspector = cSelected.querySelector("[data-testid='runtime-graph-inspector']");
	assert.ok(inspector?.className.includes("max-w-[45%]"), "Inspector must use balanced max-w-[45%]");
});

test("Cycle 83: Mapper enriches bb.subagent-anchor with human-readable name and details", () => {
	const current = {
		conversation: {
			docs: {
				"bb.subagents": {
					agents: {
						worker1: {
							name: "Independent Reviewer",
							task: "Perform security and performance checks",
							conversationId: 2,
							anchorTaskId: 466,
							ownerTaskId: 465,
						},
					},
				},
			},
		},
	};

	const meta = findSubagentMeta(current, 466);
	assert.equal(meta?.name, "Independent Reviewer");
	assert.equal(meta?.task, "Perform security and performance checks");

	const node: any = { id: 466, kind: "bb.subagent-anchor", conversationId: 1, state: { status: "running" } };
	const mapped = buildMappedNode(node, current, 1, new TaskNames(), new Map(), () => 1000);

	assert.equal(mapped.toolName, "subagent");
	assert.equal(mapped.targetHint, "Independent Reviewer");
	assert.equal(mapped.label, "bb.subagent-anchor · subagent: Independent Reviewer");
});
