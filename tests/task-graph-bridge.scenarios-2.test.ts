import test from "node:test";
import assert from "node:assert/strict";
import type { TaskGraph, TaskGraphNode, TaskGraphState } from "@earendil-works/pi-durable";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { taskSteps, startTaskGraphBridge } from "../src/runner/task-graph-bridge.ts";
import { TaskNames } from "../src/runner/task-labels.ts";
import type { DurableView } from "../src/runner/runtime-types.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import type { BBPlanStep } from "../src/runner/bridge/contracts.ts";
import type { DurableViewSource } from "../src/runner/runtime-types.ts";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { jsonFixture, taskNodeFixture, graphFixture, viewFixture, taskViewSourceFixture as viewSourceFixture } from "./fixtures/durable.ts";
import { wireFixture } from "./fixtures/wire.ts";
import { node, graph, liveView, runningCall } from "./fixtures/task-graph-bridge-support.ts";

test("startTaskGraphBridge publishes on change only", (t) => {
    t.mock.timers.enable();
    let current: {
        tasks?: TaskGraph;
    } = {};
    let notify: (() => void) | undefined;
    const view = viewSourceFixture({
        current: () => current,
        subscribe: (listener: () => void) => {
            notify = listener;
            return () => {
                notify = undefined;
            };
        },
    });
    const emitted: BBPlanStep[][] = [];
    const bridge = startTaskGraphBridge(view, (event) => emitted.push(event.steps));
    t.mock.timers.tick(50);
    assert.equal(emitted.length, 0, "no graph yet means nothing to show");
    current = { tasks: graph({ "1": node(1, "pi.generation", { status: "running", phase: "request" }) }) };
    notify?.();
    t.mock.timers.tick(50);
    assert.deepEqual(emitted, [[{ step: "#1 assistant turn", status: "active" }]]);
    notify?.();
    t.mock.timers.tick(50);
    assert.equal(emitted.length, 1, "an unchanged graph must not re-emit");
    current = { tasks: graph({ "1": node(1, "pi.generation", { status: "pending", phase: "request" }) }) };
    notify?.();
    t.mock.timers.tick(50);
    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[1], [{ step: "#1 assistant turn", status: "pending" }]);
    // A phase the panel does not show is not a change worth a new row.
    current = { tasks: graph({ "1": node(1, "pi.generation", { status: "pending", phase: "tools" }) }) };
    notify?.();
    t.mock.timers.tick(50);
    assert.equal(emitted.length, 2, "a hidden phase change must not re-emit");
    current = {};
    notify?.();
    t.mock.timers.tick(50);
    assert.equal(emitted.length, 3, "an empty graph emits a final snapshot with all tasks completed");
    assert.deepEqual(emitted[2], [{ step: "#1 assistant turn", status: "completed" }]);
    notify?.();
    t.mock.timers.tick(50);
    assert.equal(emitted.length, 3, "an unchanged empty graph must not re-emit");
    bridge.unsubscribe();
});

test("taskNames: a tool task is named from the call the harness runs in it", () => {
	const names = new TaskNames();
	names.learn(runningCall("call-1", "bash", 3, { command: "echo alpha" }));

	assert.deepEqual(
		taskSteps(
			graph({
				"1": node(1, "pi.generation", { status: "running", phase: "tools" }),
				"3": node(3, "pi.tool", { status: "running", phase: "execute" }, 1),
			}),
			names,
		),
		[
			{ step: "#1 assistant turn", status: "active" },
			{ step: "  #3 bash: echo alpha", status: "active" },
		],
	);
});

test("taskNames: a nested call names itself, a slot without a task names nothing, a learned name outlives its slot", () => {
	const names = new TaskNames();
	names.learn(
		liveView({
			// Not offered, so not started: there is no task to name yet.
			tools: [{ callId: "call-9", name: "bash", status: "pending" }],
			nestedTools: [
				{
					callId: "call-1/n1",
					name: "read",
					status: "running",
					taskId: 4,
					parentCallId: "call-1",
					parentTaskId: 3,
					arguments: { path: "src/runner/index.ts" },
				},
			],
		}),
	);

	const waiting: TaskGraphState = { status: "waiting", phase: "execute", on: [5 as never], policy: "allSettled" };
	assert.deepEqual(taskSteps(graph({ "4": node(4, "pi.tool", waiting) }), names), [
		{ step: "#4 read: src/runner/index.ts · waiting on 1", status: "pending" },
	]);

	// The slot leaves pi.live when the call ends, and the name it taught stays.
	names.learn(liveView({ tools: [] }));
	assert.deepEqual(taskSteps(graph({ "4": node(4, "pi.tool", { status: "completing", outcome: "completed" }) }), names), [
		{ step: "#4 read: src/runner/index.ts · completing (completed)", status: "completed" },
	]);
	assert.deepEqual(taskSteps(graph({ "5": node(5, "pi.tool", { status: "running", phase: "execute" }) }), names), [
		{ step: "#5 tool · execute", status: "active" },
	]);
});

test("taskNames: a name is one bounded line, and no registry changes nothing", () => {
	const names = new TaskNames();
	names.learn(
		runningCall("call-1", "bash", 3, {
			command: "  git log\n  --oneline --decorate --all --graph --stat --pretty=format:%H  ",
		}),
	);

	const tasks = graph({ "3": node(3, "pi.tool", { status: "running", phase: "execute" }) });
	const [step] = taskSteps(tasks, names);
	assert.ok(step !== undefined);
	assert.ok(step.step.startsWith("#3 bash: git log --oneline"), step.step);
	assert.equal(step.step.endsWith("…"), true, "a long command is clipped");
	assert.equal(step.step.includes("\n"), false, "a multi-line command stays on one line");
	assert.equal(step.step.length, 3 + 48, "the name is bounded");

	assert.deepEqual(taskSteps(tasks), [{ step: "#3 tool · execute", status: "active" }]);
});

test("taskSteps: retains completed tasks as completed when evicted from live graph", () => {
	const names = new TaskNames();
	const known = new Map<string, BBPlanStep>();

	// Tick 1: generation running and child tool executing
	const g1 = graph({
		"1": node(1, "pi.generation", { status: "running", phase: "tools" }),
		"2": node(2, "pi.tool", { status: "running", phase: "execute" }, 1),
	});
	const steps1 = taskSteps(g1, names, known);
	assert.deepEqual(steps1, [
		{ step: "#1 assistant turn", status: "active" },
		{ step: "  #2 tool · execute", status: "active" },
	]);

	// Tick 2: tool completed and evicted from TaskGraph (terminal eviction)
	const g2 = graph({
		"1": node(1, "pi.generation", { status: "running", phase: "tools" }),
	});
	const steps2 = taskSteps(g2, names, known);
	assert.deepEqual(steps2, [
		{ step: "#1 assistant turn", status: "active" },
		{ step: "  #2 tool · execute", status: "completed" },
	]);

	// Tick 3: new tool started under same generation
	const g3 = graph({
		"1": node(1, "pi.generation", { status: "running", phase: "tools" }),
		"3": node(3, "pi.tool", { status: "running", phase: "execute" }, 1),
	});
	const steps3 = taskSteps(g3, names, known);
	assert.deepEqual(steps3, [
		{ step: "#1 assistant turn", status: "active" },
		{ step: "  #2 tool · execute", status: "completed" },
		{ step: "  #3 tool · execute", status: "active" },
	]);
});
