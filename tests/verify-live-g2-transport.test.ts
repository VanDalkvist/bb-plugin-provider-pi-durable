import test from "node:test";
import assert from "node:assert/strict";
import { verifyLiveG2Transport } from "../scripts/g2-transport/verifier.mjs";
import type { RuntimeGraphSnapshot } from "../src/runtime-graph/types.ts";

function makeSnapshot(epoch: string, revision: number, overrides?: Partial<RuntimeGraphSnapshot>): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "sess-1", rootConversationId: "1", buildId: "b-1" },
		observation: { epoch, revision, observedAt: 1000 + revision, completeness: "complete" },
		nodes: {
			"1": {
				id: 1,
				kind: "pi.tool",
				conversationId: 1,
				background: false,
				abortRequested: false,
				state: { status: "running" },
				label: "executing tool",
			},
		},
		conversations: { "1": { id: 1 } },
		receipts: [],
		stats: { liveCount: 1, terminalCount: 0, totalCount: 1 },
		...overrides,
	};
}

function createDynamicMockLiveClient(initialEvents: any[] = []) {
	let events = [...initialEvents];
	const realtimeCallbacks = new Set<(event: any) => void>();
	let unsubscribed = false;
	let closed = false;

	return {
		threads: { events: { list: async () => events } },
		realtime: {
			subscribe: (args: { event: string; threadId: string; callback: (e: any) => void }) => {
				realtimeCallbacks.add(args.callback);
				return () => {
					realtimeCallbacks.delete(args.callback);
					unsubscribed = true;
				};
			},
		},
		appendEvent: (event: any) => {
			events.unshift(event);
		},
		triggerRealtime: () => {
			for (const cb of realtimeCallbacks) {
				cb({ event: "thread:changed", threadId: "thr-test" });
			}
		},
		close: () => { closed = true; },
		isUnsubscribed: () => unsubscribed,
		isClosed: () => closed,
	};
}

const readyStatus = {
	ready: true,
	outcome: "UNVERIFIED" as const,
	reason: "runtime_unverified",
	installedVersion: "0.3.0",
	candidateVersion: "0.3.0",
	hasExtensionKind: true,
	installed: { version: "0.3.0", status: "verified" },
	restart: { status: "unverified" },
	runtime: { status: "unverified" },
	message: "Environment precheck passed",
};

test("verify-live-g2-transport: success correlation with trigger and WS (PASS)", async () => {
	const baselineSnapshot = makeSnapshot("epoch-1", 1);
	const freshSnapshot = makeSnapshot("epoch-1", 2);
	const mockClient = createDynamicMockLiveClient([
		{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: baselineSnapshot, threadId: "thr-test", seq: 10 },
	]);

	const result = await verifyLiveG2Transport({
		client: mockClient as any,
		readiness: readyStatus,
		threadId: "thr-test",
		expectedSessionId: "sess-1",
		timeoutMs: 1000,
		trigger: async () => {
			mockClient.appendEvent({
				type: "thread/extensionState/updated",
				kind: "provider-pi-durable/runtime-graph",
				payload: freshSnapshot,
				threadId: "thr-test",
				seq: 20,
			});
			mockClient.triggerRealtime();
		},
	});

	assert.equal(result.outcome, "PASS");
	assert.equal(result.phase, "verified");
	assert.equal(result.realtimeNotified, true);
	assert.equal(result.snapshot?.observation.revision, 2);
	assert.equal(result.runtime?.status, "verified");
	assert.equal(mockClient.isUnsubscribed(), true);
	assert.equal(mockClient.isClosed(), true);
});

test("verify-live-g2-transport: historical-only REST snapshot without WS notification must NOT pass (FAILED)", async () => {
	const snapshot = makeSnapshot("epoch-1", 1);
	const mockClient = createDynamicMockLiveClient([
		{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: snapshot, threadId: "thr-test", seq: 10 },
	]);

	const result = await verifyLiveG2Transport({
		client: mockClient as any,
		readiness: readyStatus,
		threadId: "thr-test",
		expectedSessionId: "sess-1",
		timeoutMs: 100,
	});

	assert.equal(result.outcome, "FAILED");
	assert.equal(result.reason, "timeout_waiting_for_valid_snapshot");
	assert.equal(result.realtimeNotified, false);
});

test("verify-live-g2-transport: WS notification without fresh snapshot must NOT pass (FAILED)", async () => {
	const baseline = makeSnapshot("epoch-1", 1);
	const mockClient = createDynamicMockLiveClient([
		{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: baseline, threadId: "thr-test", seq: 10 },
	]);

	const result = await verifyLiveG2Transport({
		client: mockClient as any,
		readiness: readyStatus,
		threadId: "thr-test",
		expectedSessionId: "sess-1",
		timeoutMs: 100,
		trigger: async () => {
			mockClient.triggerRealtime();
		},
	});

	assert.equal(result.outcome, "FAILED");
	assert.equal(result.reason, "timeout_waiting_for_valid_snapshot");
	assert.equal(result.realtimeNotified, true);
});

test("verify-live-g2-transport: REST update without WS notification must NOT pass (FAILED)", async () => {
	const baseline = makeSnapshot("epoch-1", 1);
	const fresh = makeSnapshot("epoch-1", 2);
	const mockClient = createDynamicMockLiveClient([
		{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: baseline, threadId: "thr-test", seq: 10 },
	]);

	const result = await verifyLiveG2Transport({
		client: mockClient as any,
		readiness: readyStatus,
		threadId: "thr-test",
		expectedSessionId: "sess-1",
		timeoutMs: 100,
		trigger: async () => {
			mockClient.appendEvent({
				type: "thread/extensionState/updated",
				kind: "provider-pi-durable/runtime-graph",
				payload: fresh,
				threadId: "thr-test",
				seq: 20,
			});
		},
	});

	assert.equal(result.outcome, "FAILED");
	assert.equal(result.reason, "timeout_waiting_for_valid_snapshot");
	assert.equal(result.realtimeNotified, false);
});

test("verify-live-g2-transport: timeout and cleanup (FAILED)", async () => {
	const mockClient = createDynamicMockLiveClient([]);
	const result = await verifyLiveG2Transport({
		client: mockClient as any,
		readiness: readyStatus,
		threadId: "thr-test",
		timeoutMs: 80,
	});

	assert.equal(result.outcome, "FAILED");
	assert.equal(result.reason, "timeout_waiting_for_valid_snapshot");
	assert.equal(mockClient.isUnsubscribed(), true);
	assert.equal(mockClient.isClosed(), true);
});
