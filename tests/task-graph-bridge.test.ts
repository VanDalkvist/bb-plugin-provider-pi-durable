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

test("taskSteps: creation order with children nested under their owner", () => {
	const steps = taskSteps(
		graph({
			"1": node(1, "pi.generation", { status: "running", phase: "tools" }),
			"2": node(2, "pi.generation", { status: "pending", phase: "prepare" }),
			"3": node(3, "pi.tool", { status: "running", phase: "execute" }, 1),
			"4": node(4, "pi.tool", { status: "pending", phase: "call" }, 1),
			"5": node(5, "pi.compaction", { status: "running", phase: "summarize" }, 3),
		}),
	);

	assert.deepEqual(steps, [
		{ step: "#1 assistant turn", status: "active" },
		{ step: "  #3 tool · execute", status: "active" },
		{ step: "    #5 compacting context", status: "active" },
		{ step: "  #4 tool · call", status: "pending" },
		{ step: "#2 assistant turn", status: "pending" },
	]);
});

test("taskSteps: waiting and completing states map onto the panel's four statuses", () => {
	const steps = taskSteps(
		graph({
			"1": node(1, "pi.generation", { status: "waiting", phase: "tools", on: [2 as never, 3 as never], policy: "allSettled" }),
			"2": node(2, "pi.tool", { status: "completing", outcome: "completed" }, 1),
			"3": node(3, "pi.tool", { status: "completing", outcome: "failed" }, 1),
		}),
	);

	assert.deepEqual(steps, [
		{ step: "#1 assistant turn · waiting on 2", status: "pending" },
		{ step: "  #2 tool · completing (completed)", status: "completed" },
		{ step: "  #3 tool · completing (failed)", status: "failed" },
	]);
});

test("taskSteps: keeps a live child whose owner already left the graph", () => {
	const steps = taskSteps(graph({ "7": node(7, "app.example", { status: "running", phase: "authorize" }, 6) }));

	assert.deepEqual(steps, [{ step: "#7 app.example · authorize", status: "active" }]);
});

test("taskSteps: an empty graph yields no rows", () => {
	assert.deepEqual(taskSteps(graph({})), []);
});

test("tasks_snapshot is an explicit no-op in DeltaTranslator and emits no planSteps deltas", () => {
    const steps: BBPlanStep[] = [
        { step: "#1 assistant turn", status: "active" },
        { step: "  #2 bash: echo alpha", status: "completed" },
    ];
    const deltas = new DeltaTranslator().translate(wireFixture("tasks_snapshot", { type: "tasks_snapshot", steps }), { threadId: "thread-1" });
    assert.deepEqual(deltas, [], "tasks_snapshot must emit no deltas (discontinued native BB todo synchronization)");
});

test("tasks_snapshot without steps emits nothing", () => {
    assert.deepEqual(new DeltaTranslator().translate(wireFixture("tasks_snapshot", { type: "tasks_snapshot", steps: [] }), { threadId: "thread-1" }), []);
});

test("startTaskGraphBridge coalesces rapid graph updates into a single snapshot after 50ms", (t) => {
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
    startTaskGraphBridge(view, (event) => emitted.push(event.steps));
    // Rapid sequence of updates within 50ms
    current = { tasks: graph({ "1": node(1, "pi.generation", { status: "running", phase: "request" }) }) };
    notify?.();
    t.mock.timers.tick(15);
    assert.equal(emitted.length, 0, "must not emit before 50ms debounce window expires");
    current = {
        tasks: graph({
            "1": node(1, "pi.generation", { status: "running", phase: "tools" }),
            "2": node(2, "pi.tool", { status: "pending", phase: "call" }, 1),
        }),
    };
    notify?.();
    t.mock.timers.tick(25);
    assert.equal(emitted.length, 0, "debounce timer resets on rapid subsequent update");
    current = {
        tasks: graph({
            "1": node(1, "pi.generation", { status: "running", phase: "tools" }),
            "2": node(2, "pi.tool", { status: "running", phase: "execute" }, 1),
        }),
    };
    notify?.();
    t.mock.timers.tick(49);
    assert.equal(emitted.length, 0, "must not emit at 49ms");
    // Debounce period completes (50ms after the last update)
    t.mock.timers.tick(1);
    assert.equal(emitted.length, 1, "exactly one coalesced snapshot emitted after 50ms");
    assert.deepEqual(emitted[0], [
        { step: "#1 assistant turn", status: "active" },
        { step: "  #2 tool · execute", status: "active" },
    ]);
    // Further time passing without updates does not emit additional snapshots
    t.mock.timers.tick(100);
    assert.equal(emitted.length, 1);
});

test("startTaskGraphBridge unsubscribe cancels pending debounce timer and unsubscribes from view", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let current: {
        tasks?: TaskGraph;
    } = {};
    let notify: (() => void) | undefined;
    let unsubscribedFromView = false;
    const view = viewSourceFixture({
        current: () => current,
        subscribe: (listener: () => void) => {
            notify = listener;
            return () => {
                unsubscribedFromView = true;
                notify = undefined;
            };
        },
    });
    const emitted: BBPlanStep[][] = [];
    const handle = startTaskGraphBridge(view, (event) => emitted.push(event.steps));
    assert.equal(typeof handle?.unsubscribe, "function", "startTaskGraphBridge must return handle with unsubscribe");
    current = { tasks: graph({ "1": node(1, "pi.generation", { status: "running", phase: "request" }) }) };
    notify?.();
    assert.equal(emitted.length, 0, "update is scheduled, not yet emitted");
    handle.unsubscribe();
    assert.equal(unsubscribedFromView, true, "unsubscribe must remove listener from view");
    // Tick past the debounce delay: no snapshot should be emitted because timer was cleared
    t.mock.timers.tick(100);
    assert.equal(emitted.length, 0, "cancelled debounce timer must not emit");
    // Idempotent unsubscribe call should not throw
    handle.unsubscribe();
    // Subsequent notify should have no effect
    notify?.();
    t.mock.timers.tick(100);
    assert.equal(emitted.length, 0, "subsequent view notifications must not emit after unsubscribe");
});
