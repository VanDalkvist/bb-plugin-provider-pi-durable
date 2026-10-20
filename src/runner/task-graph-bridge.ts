import type { TaskGraph, TaskGraphNode } from "@earendil-works/pi-durable";
import type { BBPlanStep, BBTasksSnapshotEvent } from "./bridge/contracts.ts";
import type { DurableViewSource } from "./runtime-types.ts";
import { taskLabel, TaskNames } from "./task-labels.ts";

const INDENT = "  ";

function statusOf(node: TaskGraphNode): BBPlanStep["status"] {
	const state = node.state;
	if (state.status === "running") return "active";
	// A completing task's own work is done; it only waits for the tasks it owns to drain.
	if (state.status === "completing") return state.outcome === "completed" ? "completed" : "failed";
	return "pending";
}

const ownersMap = new WeakMap<Map<string, BBPlanStep>, Map<string, string | undefined>>();

/**
 * The task graph as an ordered list: creation order, children nested under their owner.
 * Retains completed tasks that have been evicted from the live graph, marking them completed.
 */
export function taskSteps(
	graph: TaskGraph,
	names?: TaskNames,
	knownSteps?: Map<string, BBPlanStep>,
	knownOwners?: Map<string, string | undefined>,
): BBPlanStep[] {
	const nodes = graph?.tasks ?? {};
	const known = knownSteps ?? new Map<string, BBPlanStep>();
	const owners = knownOwners ?? (knownSteps !== undefined ? (ownersMap.get(knownSteps) ?? new Map()) : new Map());
	if (knownSteps !== undefined && !ownersMap.has(knownSteps)) {
		ownersMap.set(knownSteps, owners);
	}

	for (const key of Object.keys(nodes)) {
		const owner = nodes[key]?.owner;
		owners.set(key, owner === undefined ? undefined : String(owner));
	}

	const allKeys = Array.from(new Set([...known.keys(), ...Object.keys(nodes)])).sort((a, b) => Number(a) - Number(b));
	const children = new Map<string, string[]>();
	for (const key of allKeys) {
		const owner = owners.get(key);
		if (owner === undefined) continue;
		const siblings = children.get(owner);
		if (siblings === undefined) children.set(owner, [key]);
		else siblings.push(key);
	}

	const allKeysSet = new Set(allKeys);
	const steps: BBPlanStep[] = [];
	const walk = (key: string, depth: number): void => {
		const node = nodes[key];
		if (node !== undefined) {
			const step: BBPlanStep = {
				step: INDENT.repeat(depth) + `#${key} ${taskLabel(node, names)}`,
				status: statusOf(node),
			};
			known.set(key, step);
			steps.push(step);
		} else {
			const existing = known.get(key);
			if (existing !== undefined) {
				existing.status = "completed";
				steps.push(existing);
			}
		}
		for (const child of children.get(key) ?? []) walk(child, depth + 1);
	};

	for (const key of allKeys) {
		const owner = owners.get(key);
		if (owner === undefined || !allKeysSet.has(owner)) walk(key, 0);
	}
	return steps;
}

export const DEFAULT_TASK_GRAPH_DEBOUNCE_MS = 50;

export interface TaskGraphBridgeController {
	unsubscribe: () => void;
}

/** Publishes the graph to BB whenever the panel would actually change; identical and empty snapshots are dropped. */
export function startTaskGraphBridge(
	view: DurableViewSource,
	output: (event: BBTasksSnapshotEvent) => void,
	debounceMs: number = DEFAULT_TASK_GRAPH_DEBOUNCE_MS,
): TaskGraphBridgeController {
	const names = new TaskNames();
	const knownSteps = new Map<string, BBPlanStep>();
	let published = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let isUnsubscribed = false;

	const publish = (): void => {
		timer = undefined;
		if (isUnsubscribed) return;
		const current = view.current();
		names.learn(current);
		const graph = current?.tasks ?? ({ tasks: {} } as TaskGraph);
		const steps = taskSteps(graph, names, knownSteps);
		const encoded = JSON.stringify(steps);
		if (steps.length === 0 || encoded === published) return;
		published = encoded;
		output({ type: "tasks_snapshot", steps });
	};

	const schedule = (): void => {
		if (isUnsubscribed) return;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (debounceMs <= 0) {
			publish();
			return;
		}
		timer = setTimeout(publish, debounceMs);
	};

	const unsubscribeView = view.subscribe(schedule);
	schedule();

	const unsubscribe = (): void => {
		if (isUnsubscribed) return;
		isUnsubscribed = true;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		unsubscribeView();
	};

	return { unsubscribe };
}

