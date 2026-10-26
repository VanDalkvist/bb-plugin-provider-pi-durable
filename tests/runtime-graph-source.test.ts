import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeGraphSource } from "../src/runner/runtime-graph-source.ts";
import type { TaskGraph, TaskGraphNode } from "@earendil-works/pi-durable";
import type { RuntimeGraphSnapshot } from "../src/runtime-graph/types.ts";

export function createMockViewSource(initialGraph: TaskGraph) {
	let currentGraph = initialGraph;
	const listeners = new Set<() => void>();
	return {
		current: () => currentGraph,
		update: (next: TaskGraph) => { currentGraph = next; for (const l of listeners) l(); },
		subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
	};
}

test("runtime-graph-source: projects live tasks into snapshot with bounded debounce", async () => {
	const initialGraph: TaskGraph = {
		tasks: {
			"10": {
				id: 10 as any,
				kind: "pi.tool",
				conversationId: 1 as any,
				background: false,
				abortRequested: false,
				state: { status: "running", phase: "execute" },
				conversations: [],
			},
		},
	};

	const viewSource = createMockViewSource(initialGraph);
	const snapshots: RuntimeGraphSnapshot[] = [];
	let nowTime = 1000;
	const source = new RuntimeGraphSource(
		viewSource,
		{ sessionId: "sess_1", rootConversationId: "1", buildId: "b1" },
		{ debounceMs: 50, maxDebounceMs: 200, clock: () => nowTime },
	);

	const unsubscribe = source.subscribe((s) => snapshots.push(s));
	await new Promise((r) => setTimeout(r, 70));

	assert.equal(snapshots.length, 1);
	assert.equal(snapshots[0]?.nodes["10"]?.id, 10);
	assert.equal(snapshots[0]?.nodes["10"]?.state.status, "running");
	assert.equal(snapshots[0]?.stats.liveCount, 1);
	assert.equal(snapshots[0]?.observation.completeness, "complete");

	unsubscribe();
	source.teardown();
});

test("runtime-graph-source: sustained updates do not starve publication (maxDebounceMs fires)", async () => {
	const initialGraph: TaskGraph = { tasks: {} };
	const viewSource = createMockViewSource(initialGraph);
	const snapshots: RuntimeGraphSnapshot[] = [];

	const source = new RuntimeGraphSource(
		viewSource,
		{ sessionId: "sess_1", rootConversationId: "1", buildId: "b1" },
		{ debounceMs: 60, maxDebounceMs: 150 },
	);

	const unsubscribe = source.subscribe((s) => snapshots.push(s));
	const interval = setInterval(() => {
		viewSource.update({
			tasks: {
				"1": {
					id: 1 as any,
					kind: "pi.tool",
					conversationId: 1 as any,
					background: false,
					abortRequested: false,
					state: { status: "running", phase: String(Date.now()) },
					conversations: [],
				},
			},
		});
	}, 20);

	await new Promise((r) => setTimeout(r, 250));
	clearInterval(interval);

	assert.ok(snapshots.length >= 1, `Expected at least 1 snapshot, got ${snapshots.length}`);
	unsubscribe();
	source.teardown();
});

test("runtime-graph-source: marks completeness as limited when live tasks exceed 512", async () => {
	const tasks: Record<string, TaskGraphNode> = {};
	for (let i = 1; i <= 515; i++) {
		tasks[String(i)] = {
			id: i as any,
			kind: "pi.tool",
			conversationId: 1 as any,
			background: false,
			abortRequested: false,
			state: { status: "pending", phase: "init" },
			conversations: [],
		};
	}

	const viewSource = createMockViewSource({ tasks });
	const snapshots: RuntimeGraphSnapshot[] = [];
	const source = new RuntimeGraphSource(
		viewSource,
		{ sessionId: "sess_1", rootConversationId: "1", buildId: "b1" },
		{ debounceMs: 20 },
	);

	source.subscribe((s) => snapshots.push(s));
	await new Promise((r) => setTimeout(r, 40));

	assert.equal(snapshots.length, 1);
	assert.equal(snapshots[0]?.observation.completeness, "limited");
	assert.equal(Object.keys(snapshots[0]?.nodes ?? {}).length, 512);
	assert.equal(snapshots[0]?.stats.totalCount, 515);

	source.teardown();
});

test("runtime-graph-source: deduplicates identical structural state before revision and timestamp (does not spam)", async () => {
	const initialGraph: TaskGraph = {
		tasks: {
			"10": {
				id: 10 as any,
				kind: "pi.tool",
				conversationId: 1 as any,
				background: false,
				abortRequested: false,
				state: { status: "running", phase: "execute" },
				conversations: [],
			},
		},
	};

	const viewSource = createMockViewSource(initialGraph);
	const snapshots: RuntimeGraphSnapshot[] = [];
	let nowTime = 1000;
	const source = new RuntimeGraphSource(
		viewSource,
		{ sessionId: "sess_1", rootConversationId: "1", buildId: "b1" },
		{ debounceMs: 20, maxDebounceMs: 50, clock: () => nowTime },
	);

	const unsubscribe = source.subscribe((s) => snapshots.push(s));
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(snapshots.length, 1);
	assert.equal(snapshots[0]?.observation.revision, 1);

	// Clock advances with identical structural graph
	nowTime = 2000;
	viewSource.update({ ...initialGraph });
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(snapshots.length, 1, "Duplicate structural state must not trigger a new publication");

	// Introduce actual structural change
	nowTime = 3000;
	viewSource.update({
		tasks: {
			"10": {
				...initialGraph.tasks["10"]!,
				state: { status: "completing", outcome: "completed" as any },
			},
		},
	});

	await new Promise((r) => setTimeout(r, 40));
	assert.equal(snapshots.length, 2, "Real structural change must publish new snapshot");
	assert.equal(snapshots[1]?.observation.revision, 2);

	unsubscribe();
	source.teardown();
});
