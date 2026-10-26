import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { translateRuntimeGraphSnapshot } from "../src/host/runtime-graph-delta.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import type { RuntimeGraphSnapshot } from "../src/runtime-graph/types.ts";
import type { RunnerEvent } from "../src/contracts/runner-event.ts";

function createValidSnapshot(): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "sess_test", rootConversationId: "1", buildId: "b1" },
		observation: { epoch: "e1", revision: 10, observedAt: 1000, completeness: "complete" },
		nodes: {
			"1": {
				id: 1,
				kind: "pi.tool",
				conversationId: 1,
				background: false,
				abortRequested: false,
				state: { status: "running" },
				label: "root tool",
			},
			"2": {
				id: 2,
				kind: "pi.tool",
				conversationId: 2,
				background: false,
				abortRequested: false,
				state: { status: "running" },
				label: "child tool",
			},
		},
		conversations: {
			"1": { id: 1 },
			"2": { id: 2, owner: { conversationId: 1, taskId: 1 } },
		},
		receipts: [],
		stats: { liveCount: 2, terminalCount: 0, totalCount: 2 },
	};
}

test("runtime-graph-bridge: translates runtime_graph_snapshot to valid extension.state delta", () => {
	const snapshot = createValidSnapshot();
	const deltas = translateRuntimeGraphSnapshot({ snapshot });

	assert.equal(deltas.length, 1);
	const delta = deltas[0]!;
	assert.equal(delta.kind, "extension.state");
	if (delta.kind === "extension.state") {
		assert.equal(delta.extensionKind, "provider-pi-durable/runtime-graph");
		assert.deepEqual(delta.payload, snapshot);
	}

	// Validate strictly with BB SDK threadDeltaSchema
	const parsed = threadDeltaSchema.safeParse(delta);
	assert.equal(parsed.success, true);
});

test("runtime-graph-bridge: isolates snapshot when targetConversationId is child conversation", () => {
	const snapshot = createValidSnapshot();
	const deltas = translateRuntimeGraphSnapshot({ snapshot }, 2);

	assert.equal(deltas.length, 1);
	const delta = deltas[0]!;
	if (delta.kind === "extension.state") {
		const payload = delta.payload as RuntimeGraphSnapshot;
		// Child 2 sees only its own nodes
		assert.deepEqual(Object.keys(payload.nodes), ["2"]);
		assert.deepEqual(Object.keys(payload.conversations), ["2"]);
		assert.equal(payload.stats.liveCount, 1);
	}
});

test("runtime-graph-bridge: DeltaTranslator handles runtime_graph_snapshot event", () => {
	const snapshot = createValidSnapshot();
	const event: RunnerEvent = {
		type: "runtime_graph_snapshot",
		snapshot,
	} as any;

	const translator = new DeltaTranslator();
	const deltas = translator.translate(event, { threadId: "thr_1" });

	assert.equal(deltas.length, 1);
	const delta = deltas[0]!;
	assert.equal(delta.kind, "extension.state");
	if (delta.kind === "extension.state") {
		assert.equal(delta.extensionKind, "provider-pi-durable/runtime-graph");
	}
	assert.equal(threadDeltaSchema.safeParse(delta).success, true);
});

test("runtime-graph-bridge: server.ts registers extensionKinds with runtime-graph state schema", async () => {
	const plugin = (await import("../server.ts")).default;
	let registeredProvider: any = null;

	const fakeHost = {
		storage: { kv: { get: async () => undefined, set: async () => {} } },
		settings: { define() {} },
		rpc: { register() {} },
		providers: {
			register(declaration: any) {
				registeredProvider = declaration;
				return { dispose() {} };
			},
		},
	};

	await plugin(fakeHost as any);

	assert.ok(registeredProvider, "Provider must be registered");
	assert.ok(registeredProvider.extensionKinds, "extensionKinds must be registered");
	assert.ok(registeredProvider.extensionKinds["runtime-graph"], "runtime-graph extensionKind must be present");
	assert.ok(registeredProvider.extensionKinds["runtime-graph"].state, "runtime-graph.state schema must be present");
});

test("runtime-graph-bridge: SessionSubagentHandler delivers scoped graph snapshot to child threads", async () => {
	const { SessionSubagentHandler } = await import("../src/host/session-subagent-handler.ts");
	const handler = new SessionSubagentHandler();

	const notifications: Array<{ method: string; params: any }> = [];
	const fakeSession = {
		options: { threadId: "thr_parent", cwd: "/tmp", providerOptions: {} },
		getThreadIdForConversation: (id: string | number) => (String(id) === "2" ? "thr_child_2" : undefined),
		registerThread: () => {},
	};

	handler.markActive(2, { task: "child task" });
	handler.markActive(3, { task: "pending child task" });

	const snapshot = createValidSnapshot();
	const event: RunnerEvent = {
		type: "runtime_graph_snapshot",
		snapshot,
	} as any;

	const shouldDropFromParent = handler.handleEvent(event, fakeSession as any, (method, params) => {
		notifications.push({ method, params });
	});

	// Whole-session snapshot must NOT be dropped from parent
	assert.equal(shouldDropFromParent, false, "Whole-session snapshot must be delivered to parent thread");

	// Must deliver scoped snapshot to registered child 2
	const child2Notification = notifications.find((n) => n.params?.threadId === "thr_child_2");
	assert.ok(child2Notification, "Registered child 2 must receive a thread/delta notification");

	const child2Delta = child2Notification?.params?.deltas?.[0];
	assert.equal(child2Delta?.kind, "extension.state");
	assert.equal(child2Delta?.extensionKind, "provider-pi-durable/runtime-graph");
	const child2Payload = child2Delta?.payload as RuntimeGraphSnapshot;
	assert.deepEqual(Object.keys(child2Payload.nodes), ["2"], "Child 2 snapshot must only contain scoped node 2");

	// For unregistered child 3, snapshot must be buffered and delivered on flushBufferedDeltas
	const flushedNotifications: Array<{ method: string; params: any }> = [];
	handler.flushBufferedDeltas(3, "thr_child_3", { cwd: "/tmp" }, (method, params) => {
		flushedNotifications.push({ method, params });
	});

	const child3Notification = flushedNotifications.find((n) => n.params?.threadId === "thr_child_3");
	assert.ok(child3Notification, "Pending child 3 must receive buffered scoped graph snapshot on flush");
});

