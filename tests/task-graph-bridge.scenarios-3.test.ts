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

test("startTaskGraphBridge: emits final snapshot when graph empties with all steps completed and no spinners", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
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
    // 1. Graph with active generation and active subagent
    current = {
        tasks: graph({
            "1": node(1, "pi.generation", { status: "running", phase: "tools" }),
            "2": node(2, "pi.tool", { status: "running", phase: "execute" }, 1),
        }),
    };
    notify?.();
    t.mock.timers.tick(50);
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], [
        { step: "#1 assistant turn", status: "active" },
        { step: "  #2 tool · execute", status: "active" },
    ]);
    // 2. Graph becomes empty (turn finishes, terminal eviction)
    current = { tasks: graph({}) };
    notify?.();
    t.mock.timers.tick(50);
    assert.equal(emitted.length, 2, "final snapshot must be emitted when graph empties");
    const finalSteps = emitted[1];
    assert.equal(finalSteps.length, 2);
    // All steps must be completed, none active or pending (no hanging spinners in BB plan panel)
    for (const step of finalSteps) {
        assert.equal(step.status, "completed", `step ${step.step} must have status completed`);
    }
    assert.deepEqual(finalSteps, [
        { step: "#1 assistant turn", status: "completed" },
        { step: "  #2 tool · execute", status: "completed" },
    ]);
    // 3. Repeated empty tick must not re-emit
    notify?.();
    t.mock.timers.tick(50);
    assert.equal(emitted.length, 2, "subsequent empty graph tick must not emit duplicate snapshot");
    bridge.unsubscribe();
});

test("taskNames: subagent tool displays '#id subagent: <task>'", () => {
	const names = new TaskNames();
	names.learn(
		runningCall("call-sub-1", "subagent", 2, {
			task: "run all unit tests and verify output",
		}),
	);

	const steps = taskSteps(
		graph({
			"1": node(1, "pi.generation", { status: "running", phase: "tools" }),
			"2": node(2, "pi.tool", { status: "running", phase: "execute" }, 1),
		}),
		names,
	);

	assert.deepEqual(steps, [
		{ step: "#1 assistant turn", status: "active" },
		{ step: "  #2 subagent: run all unit tests and verify output", status: "active" },
	]);
});

test("taskSteps: preserves failed task status across task graph eviction and empty graph finalization", () => {
	const names = new TaskNames();
	const known = new Map<string, BBPlanStep>();

	// Tick 1: generation running and child tool completing with failure
	const g1 = graph({
		"1": node(1, "pi.generation", { status: "running", phase: "tools" }),
		"2": node(2, "pi.tool", { status: "completing", outcome: "failed" }, 1),
	});
	const steps1 = taskSteps(g1, names, known);
	assert.deepEqual(steps1, [
		{ step: "#1 assistant turn", status: "active" },
		{ step: "  #2 tool · completing (failed)", status: "failed" },
	]);

	// Tick 2: tool completed and evicted from TaskGraph (terminal eviction), parent still running
	const g2 = graph({
		"1": node(1, "pi.generation", { status: "running", phase: "tools" }),
	});
	const steps2 = taskSteps(g2, names, known);
	assert.deepEqual(steps2, [
		{ step: "#1 assistant turn", status: "active" },
		{ step: "  #2 tool · completing (failed)", status: "failed" },
	]);

	// Tick 3: graph becomes completely empty (turn finishes)
	const g3 = graph({});
	const steps3 = taskSteps(g3, names, known);
	assert.deepEqual(steps3, [
		{ step: "#1 assistant turn", status: "completed" },
		{ step: "  #2 tool · completing (failed)", status: "failed" },
	]);
});

test("startTaskGraphBridge: preserves failed status when task is evicted and when graph empties", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
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
    // 1. Tool failed
    current = {
        tasks: graph({
            "1": node(1, "pi.generation", { status: "running", phase: "tools" }),
            "2": node(2, "pi.tool", { status: "completing", outcome: "failed" }, 1),
        }),
    };
    notify?.();
    t.mock.timers.tick(50);
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], [
        { step: "#1 assistant turn", status: "active" },
        { step: "  #2 tool · completing (failed)", status: "failed" },
    ]);
    // 2. Graph empties (turn ends)
    current = { tasks: graph({}) };
    notify?.();
    t.mock.timers.tick(50);
    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[1], [
        { step: "#1 assistant turn", status: "completed" },
        { step: "  #2 tool · completing (failed)", status: "failed" },
    ]);
    bridge.unsubscribe();
});
