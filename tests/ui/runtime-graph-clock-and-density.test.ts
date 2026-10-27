import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { TaskTreeItem } from "../../src/ui/runtime-graph/types.ts";

setupDom();
const { render, fireEvent, act } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphSegmentDetails } = await import("../../src/ui/runtime-graph/segment.tsx");
const { findBestActiveTaskId } = await import("../../src/ui/runtime-graph/tree-order.ts");

function makeNodeRow(id: number, status: string, startedAt?: number, durationMs?: number): TaskTreeItem {
	const isTerminal = status === "completed" || status === "failed";
	return {
		id,
		kind: "pi.tool",
		label: `Task #${id}`,
		conversationId: 1,
		isTerminal,
		liveNode: isTerminal ? undefined : ({
			id, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false,
			state: { status }, label: `Task #${id}`, startedAt,
		} as any),
		receipt: isTerminal ? ({
			taskId: id, kind: "pi.tool", conversationId: 1,
			outcome: status, durationMs: durationMs ?? 150,
		} as any) : undefined,
		children: [],
	};
}

test("Follow active prioritizes genuine running task over waiting ancestor or sleeping courier", () => {
	const waitingParent = makeNodeRow(10, "waiting");
	const sleepingCourier = makeNodeRow(11, "sleeping");
	const genuineRunningChild = makeNodeRow(12, "running");

	waitingParent.children = [sleepingCourier, genuineRunningChild];

	const bestId = findBestActiveTaskId([waitingParent]);
	assert.equal(bestId, 12, "Must select genuine running task #12 rather than waiting ancestor #10 or sleeping courier #11");
});

test("Native compact wrapper: removes double border, rounded-md, shadow-sm, my-1 and h-80", () => {
	const state: any = {
		threadId: "thr-1", status: "ok", snapshot: { nodes: {}, receipts: [], stats: {} },
		tree: [makeNodeRow(1, "completed", 1000, 200)],
		selectedTaskId: null, selectedItem: null, collapsedTaskIds: new Set(),
		selectTask: () => {}, toggleCollapse: () => {},
	};

	const { container } = render(React.createElement(RuntimeGraphSegmentDetails, {
		threadId: "thr-1", projectId: "p-1", environment: null, segments: [], isExpanded: true, onToggle: () => {}, testState: state,
	}));

	const root = container.firstElementChild as HTMLElement;
	assert.ok(root, "Root element must exist");

	// Verify absence of redundant host-duplicated classes
	const className = root.className;
	assert.ok(!className.includes("border rounded-md"), `Must not have border rounded-md: ${className}`);
	assert.ok(!className.includes("shadow-sm"), `Must not have shadow-sm: ${className}`);
	assert.ok(!className.includes("my-1"), `Must not have my-1: ${className}`);
	assert.ok(!className.includes("h-80"), `Must not have fixed h-80: ${className}`);
	assert.ok(className.includes("max-h-60") || className.includes("max-h-64"), `Must have compact max height: ${className}`);
	assert.ok(className.includes("w-full"), `Must have w-full: ${className}`);
});

test("Bounded view clock: 1Hz clock advances running task duration without affecting terminal duration", async () => {
	const startTime = Date.now() - 8800; // 8.8s ago
	const runningTask = makeNodeRow(10, "running", startTime, 8800);
	const terminalTask = makeNodeRow(11, "completed", undefined, 350); // fixed 350ms

	const state: any = {
		threadId: "thr-clock", status: "ok", snapshot: { nodes: {}, receipts: [], stats: {} },
		tree: [runningTask, terminalTask],
		selectedTaskId: null, selectedItem: null, collapsedTaskIds: new Set(),
		selectTask: () => {}, toggleCollapse: () => {},
	};

	const { container, unmount } = render(React.createElement(RuntimeGraphSegmentDetails, {
		threadId: "thr-clock", projectId: "p-1", environment: null, segments: [], isExpanded: true, onToggle: () => {}, testState: state,
	}));

	// Expand folded finished history so terminal task row is in DOM
	const seeMoreBtn = container.querySelector("button[data-history-toggle='true']");
	if (seeMoreBtn) {
		fireEvent.click(seeMoreBtn);
	}

	const rowRunning = container.querySelector("[data-task-id='10']");
	const rowTerminal = container.querySelector("[data-task-id='11']");

	assert.ok(rowRunning?.textContent?.includes("8.8s") || rowRunning?.textContent?.includes("8.9s"), `Expected ~8.8s, got ${rowRunning?.textContent}`);
	assert.ok(rowTerminal?.textContent?.includes("350ms"), "Terminal task must show exact 350ms");

	// Wait 2050ms for 2 clock ticks (at 1000ms each)
	await new Promise((resolve) => setTimeout(resolve, 2050));

	const rowRunningAfter = container.querySelector("[data-task-id='10']");
	const rowTerminalAfter = container.querySelector("[data-task-id='11']");

	// Duration should have advanced by ~2 seconds to ~10.8s without external events
	assert.ok(
		rowRunningAfter?.textContent?.includes("10.8s") || rowRunningAfter?.textContent?.includes("10.9s"),
		`Expected advanced duration ~10.8s, got ${rowRunningAfter?.textContent}`,
	);

	// Terminal duration must remain strictly fixed at 350ms
	assert.ok(rowTerminalAfter?.textContent?.includes("350ms"), "Terminal duration must not drift");

	unmount();
});
