import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { translateAgentEnd } from "../src/host/message-delta-translator.ts";
import {
	handleThreadStop,
	type BridgeRouterContext,
	type ThreadStopParams,
} from "../src/host/bridge-router.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import type { DurableView } from "../src/runner/runtime.ts";
import type {
	BBWireEvent,
	BBTurnEndEvent,
	BBAgentEndEvent,
} from "../src/runner/bridge/contracts.ts";
import type { RunnerEvent } from "../src/host/types.ts";
import type { PiThreadSession } from "../src/host/session.ts";

test("translateAgentEnd: translates aborted turn to status 'interrupted' in turn.boundary", () => {
	// Case A: event.aborted === true
	const eventAborted: RunnerEvent = {
		type: "agent_end",
		aborted: true,
		providerCheckpointId: "chk_abort_1",
		messages: [{ role: "assistant", content: [{ type: "text", text: "Cancelled work" }] }],
	};
	const resA = translateAgentEnd(eventAborted, "", false);
	const boundaryA = resA.deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundaryA, "turn.boundary must be emitted");
	assert.equal(boundaryA.status, "interrupted");
	assert.equal(boundaryA.claimIfIdle, true);
	assert.equal(boundaryA.providerCheckpointId, "chk_abort_1");
	assert.equal(threadDeltaSchema.safeParse(boundaryA).success, true);

	// Case B: event.stopReason === 'aborted'
	const eventStopReason: RunnerEvent = {
		type: "agent_end",
		stopReason: "aborted",
		messages: [],
	};
	const resB = translateAgentEnd(eventStopReason, "", false);
	const boundaryB = resB.deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundaryB);
	assert.equal(boundaryB.status, "interrupted");
	assert.equal(threadDeltaSchema.safeParse(boundaryB).success, true);

	// Case C: assistant message stopReason === 'aborted'
	const eventMsgAborted: RunnerEvent = {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "Partial output" }],
				stopReason: "aborted",
			},
		],
	};
	const resC = translateAgentEnd(eventMsgAborted, "", false);
	const boundaryC = resC.deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundaryC);
	assert.equal(boundaryC.status, "interrupted");
	assert.equal(threadDeltaSchema.safeParse(boundaryC).success, true);

	// Case D: regular non-aborted completion translates to 'completed'
	const eventCompleted: RunnerEvent = {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "Complete" }],
				stopReason: "stop",
			},
		],
	};
	const resD = translateAgentEnd(eventCompleted, "", false);
	const boundaryD = resD.deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundaryD);
	assert.equal(boundaryD.status, "completed");
	assert.equal(threadDeltaSchema.safeParse(boundaryD).success, true);
});

test("threadDeltaSchema: validates session.ended delta strictly", () => {
	const sessionEndedDelta = { kind: "session.ended" };
	const parseResult = threadDeltaSchema.safeParse(sessionEndedDelta);
	assert.equal(parseResult.success, true, "session.ended must strictly conform to threadDeltaSchema");
});

test("handleThreadStop: intent 'interrupt' emits session.ended, aborts session, returns providerCheckpointId", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];
	const errors: Array<{ id: string | number; code: number; message: string }> = [];

	let abortCalled = false;
	const mockSession = {
		runner: { exited: false },
		abort: async () => {
			abortCalled = true;
		},
		getLastCheckpointId: () => "chk_last_42",
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry(() => {});
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_interrupt_1", mockSession);

	const ctx: BridgeRouterContext = {
		registry,
		sendNotification: (method, params) => notifications.push({ method, params }),
		sendResult: (id, result) => results.push({ id, result }),
		sendError: (id, code, message) => errors.push({ id, code, message }),
	};

	const params: ThreadStopParams = {
		threadId: "thr_interrupt_1",
		intent: "interrupt",
		activeTurnId: "turn_999",
	};

	await handleThreadStop("req_stop_1", params, ctx);

	// 1. Session abort was called
	assert.equal(abortCalled, true, "session.abort() must be called on intent 'interrupt'");

	// 2. session.ended delta was emitted
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].method, "thread/delta");
	assert.equal(notifications[0].params.threadId, "thr_interrupt_1");
	const deltas = notifications[0].params.deltas as Array<{ kind: string }>;
	assert.deepEqual(deltas, [{ kind: "session.ended" }]);
	assert.equal(threadDeltaSchema.safeParse(deltas[0]).success, true);

	// 3. Response contains ok: true and providerCheckpointId
	assert.equal(results.length, 1);
	assert.equal(results[0].id, "req_stop_1");
	assert.deepEqual(results[0].result, {
		ok: true,
		providerCheckpointId: "chk_last_42",
	});

	// 4. Session is NOT stopped/purged from registry
	assert.equal(registry.get("thr_interrupt_1"), mockSession);
});

test("handleThreadStop: intent 'interrupt' without active session returns null checkpointId", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];
	const errors: Array<{ id: string | number; code: number; message: string }> = [];

	const registry = new SessionRegistry(() => {});
	const ctx: BridgeRouterContext = {
		registry,
		sendNotification: (method, params) => notifications.push({ method, params }),
		sendResult: (id, result) => results.push({ id, result }),
		sendError: (id, code, message) => errors.push({ id, code, message }),
	};

	await handleThreadStop("req_stop_2", { threadId: "thr_unknown", intent: "interrupt" }, ctx);

	assert.equal(notifications.length, 0, "No notifications emitted when session is absent");
	assert.equal(results.length, 1);
	assert.deepEqual(results[0].result, { ok: true, providerCheckpointId: null });
});

test("handleThreadStop: intent 'release' stops session in registry and returns ok: true", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];
	const errors: Array<{ id: string | number; code: number; message: string }> = [];

	let closeCalled = false;
	const mockSession = {
		runner: { exited: false },
		closeGracefully: async () => {
			closeCalled = true;
		},
		getLastCheckpointId: () => "chk_33",
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry(() => {});
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_release_1", mockSession);

	const ctx: BridgeRouterContext = {
		registry,
		sendNotification: (method, params) => notifications.push({ method, params }),
		sendResult: (id, result) => results.push({ id, result }),
		sendError: (id, code, message) => errors.push({ id, code, message }),
	};

	await handleThreadStop("req_stop_3", { threadId: "thr_release_1", intent: "release" }, ctx);

	assert.equal(closeCalled, true, "Session must be closed on release");
	assert.equal(registry.get("thr_release_1"), undefined, "Session must be removed from registry on release");
	assert.equal(results.length, 1);
	assert.deepEqual(results[0].result, { ok: true });
});

test("BBEventAdapter: propagates stopReason 'aborted' into turn_end and agent_end wire events", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));

	const viewWithAbortedEntry = {
		conversation: {
			entries: [
				{
					id: 201,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [{ type: "text", text: "Interrupted partial" }],
							stopReason: "aborted",
						},
					],
				},
			],
			docs: {},
		},
	} as unknown as DurableView;

	adapter.handleEvent({ type: "turn_end" }, viewWithAbortedEntry);
	adapter.handleEvent({ type: "run_end", inputs: [] }, viewWithAbortedEntry);

	const turnEnd = emitted.find((e): e is BBTurnEndEvent => e.type === "turn_end");
	assert.ok(turnEnd, "turn_end wire event must be emitted");
	assert.equal(turnEnd.aborted, true, "turn_end must have aborted: true");
	assert.equal(turnEnd.stopReason, "aborted");
	assert.equal(turnEnd.message?.stopReason, "aborted");

	const agentEnd = emitted.find((e): e is BBAgentEndEvent => e.type === "agent_end");
	assert.ok(agentEnd, "agent_end wire event must be emitted");
	assert.equal(agentEnd.aborted, true, "agent_end must have aborted: true");
	assert.equal(agentEnd.stopReason, "aborted");
	assert.equal(agentEnd.messages[0]?.stopReason, "aborted");
});

test("PiThreadSession: retains lastCheckpointId from incoming runner events", async () => {
	// Verify that PiThreadSession records providerCheckpointId when an event arrives
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const sessionClass = (await import("../src/host/session.ts")).PiThreadSession;

	const session = new sessionClass(
		{
			threadId: "thr_chk_test",
			providerThreadId: "pi_chk_test",
			sessionFilePath: "/tmp/fake.jsonl",
			sessionDir: "/tmp",
			extensionPath: "/tmp",
			scratchDir: "/tmp",
		},
		(method, params) => notifications.push({ method, params }),
	);

	assert.equal(session.getLastCheckpointId(), null, "Initial checkpointId must be null");

	// Simulate event arrival via private handleRunnerEvent
	const handleEvent = (session as unknown as { handleRunnerEvent: (e: RunnerEvent) => Promise<void> }).handleRunnerEvent.bind(session);

	try {
		await handleEvent({
			type: "snapshot",
			providerCheckpointId: "chk_init_001",
		});
		assert.equal(session.getLastCheckpointId(), "chk_init_001");

		await handleEvent({
			type: "agent_end",
			providerCheckpointId: "chk_turn_002",
			messages: [],
		});
		assert.equal(session.getLastCheckpointId(), "chk_turn_002");
	} finally {
		session.kill();
	}
});
