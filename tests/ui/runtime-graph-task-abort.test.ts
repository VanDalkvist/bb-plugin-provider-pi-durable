import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { TaskTreeItem } from "../../src/ui/runtime-graph/types.ts";
import { rpcContract } from "../../src/rpc/contract.ts";

setupDom();
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphDetails } = await import("../../src/ui/runtime-graph/details.tsx");

test.afterEach(() => {
	cleanup();
});

test("Cycle 95: rpcContract defines valid task_abort method schema", () => {
	const method = rpcContract.task_abort;
	assert.ok(method, "task_abort must be defined in rpcContract");

	const valid = method.input.safeParse({ threadId: "thr_test123", taskId: 42 });
	assert.ok(valid.success);

	const invalidNegative = method.input.safeParse({ threadId: "thr_test123", taskId: -1 });
	assert.ok(!invalidNegative.success);

	const invalidZero = method.input.safeParse({ threadId: "thr_test123", taskId: 0 });
	assert.ok(!invalidZero.success);

	const validOutput = method.output.safeParse({ ok: true });
	assert.ok(validOutput.success);
});

test("Cycle 95: RuntimeGraphDetails renders Abort button for active running task", () => {
	let abortedTaskId: number | null = null;
	const activeTask: TaskTreeItem = {
		id: 42,
		kind: "pi.tool",
		label: "bash: sleep 100",
		conversationId: 1,
		isTerminal: false,
		children: [],
		liveNode: {
			id: 42,
			kind: "pi.tool",
			conversationId: 1,
			background: false,
			abortRequested: false,
			state: { status: "running", phase: "execute" },
			label: "bash: sleep 100",
			startedAt: 1000,
		},
	};

	const { getByRole } = render(
		React.createElement(RuntimeGraphDetails, {
			selectedItem: activeTask,
			onAbortTask: (id) => { abortedTaskId = id; },
		}),
	);

	const abortBtn = getByRole("button", { name: "Abort task #42" });
	assert.ok(abortBtn);
	fireEvent.click(abortBtn);
	assert.equal(abortedTaskId, 42);
});

test("Cycle 95: RuntimeGraphDetails hides Abort button when task is completed or already aborted", () => {
	const completedTask: TaskTreeItem = {
		id: 43,
		kind: "pi.tool",
		label: "read: file.txt",
		conversationId: 1,
		isTerminal: true,
		children: [],
		receipt: {
			taskId: 43,
			conversationId: 1,
			kind: "pi.tool",
			outcome: "completed",
			isToolError: false,
			endedAt: 2000,
			durationMs: 50,
		},
	};

	const { queryByRole: queryCompleted } = render(
		React.createElement(RuntimeGraphDetails, {
			selectedItem: completedTask,
			onAbortTask: () => {},
		}),
	);
	assert.equal(queryCompleted("button", { name: "Abort task #43" }), null);

	cleanup();

	const abortedTask: TaskTreeItem = {
		id: 44,
		kind: "pi.tool",
		label: "subagent",
		conversationId: 1,
		isTerminal: false,
		children: [],
		liveNode: {
			id: 44,
			kind: "pi.tool",
			conversationId: 1,
			background: false,
			abortRequested: true,
			state: { status: "running", phase: "execute" },
			label: "subagent",
			startedAt: 1000,
		},
	};

	const { queryByRole: queryAborted } = render(
		React.createElement(RuntimeGraphDetails, {
			selectedItem: abortedTask,
			onAbortTask: () => {},
		}),
	);
	assert.equal(queryAborted("button", { name: "Abort task #44" }), null);
});
