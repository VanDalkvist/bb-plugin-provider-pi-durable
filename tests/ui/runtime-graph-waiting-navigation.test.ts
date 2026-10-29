import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { TaskTreeItem } from "../../src/ui/runtime-graph/types.ts";

setupDom();
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphTree } = await import("../../src/ui/runtime-graph/tree.tsx");
const { RuntimeGraphDetails } = await import("../../src/ui/runtime-graph/details.tsx");
const { NodeRowWaitingPills } = await import("../../src/ui/runtime-graph/node-row-waiting.tsx");

test.afterEach(() => {
	cleanup();
});

test("Cycle 94: NodeRowWaitingPills renders clickable buttons and calls onSelectTaskId", () => {
	const selectedIds: number[] = [];
	const { getByRole } = render(
		React.createElement(NodeRowWaitingPills, {
			waitingOn: [42, 99],
			onSelectTaskId: (id) => selectedIds.push(id),
		}),
	);

	const btn42 = getByRole("button", { name: "Select task #42" });
	assert.ok(btn42);
	fireEvent.click(btn42);
	assert.deepEqual(selectedIds, [42]);

	const btn99 = getByRole("button", { name: "Select task #99" });
	assert.ok(btn99);
	fireEvent.click(btn99);
	assert.deepEqual(selectedIds, [42, 99]);
});

test("Cycle 94: RuntimeGraphTree navigates to waiting task on pill click without toggling selection", () => {
	const selectedIds: number[] = [];
	const waitingTask: TaskTreeItem = {
		id: 10,
		kind: "pi.tool",
		label: "subagent",
		conversationId: 1,
		isTerminal: false,
		waitingOn: [20],
		children: [],
		liveNode: {
			id: 10,
			kind: "pi.tool",
			conversationId: 1,
			background: false,
			abortRequested: false,
			state: { status: "waiting", phase: "wait", on: [20], policy: "all" },
			label: "subagent",
			startedAt: 1000,
		},
	};

	const { getByRole } = render(
		React.createElement(RuntimeGraphTree, {
			tree: [waitingTask],
			selectedTaskId: null,
			collapsedTaskIds: new Set(),
			onSelectTask: (id) => selectedIds.push(id),
			onToggleCollapse: () => {},
		}),
	);

	const pill = getByRole("button", { name: "Select task #20" });
	assert.ok(pill);
	fireEvent.click(pill);
	assert.deepEqual(selectedIds, [20]);
});

test("Cycle 94: RuntimeGraphDetails renders clickable owner and waiting on links", () => {
	const selectedIds: number[] = [];
	const taskItem: TaskTreeItem = {
		id: 50,
		kind: "pi.tool",
		label: "test",
		conversationId: 1,
		ownerId: 15,
		isTerminal: false,
		children: [],
		liveNode: {
			id: 50,
			kind: "pi.tool",
			conversationId: 1,
			owner: 15,
			background: false,
			abortRequested: false,
			state: { status: "waiting", phase: "wait", on: [15, 33], policy: "all" },
			label: "test",
			startedAt: 1000,
		},
	};

	const { getByRole } = render(
		React.createElement(RuntimeGraphDetails, {
			selectedItem: taskItem,
			onSelectTaskId: (id) => selectedIds.push(id),
		}),
	);

	const ownerBtn = getByRole("button", { name: "Select owner task #15" });
	assert.ok(ownerBtn);
	fireEvent.click(ownerBtn);

	const wait33Btn = getByRole("button", { name: "Select task #33" });
	assert.ok(wait33Btn);
	fireEvent.click(wait33Btn);

	assert.deepEqual(selectedIds, [15, 33]);
});
