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

function createMockLiveClient(events: any[]) {
	let realtimeCallback: ((event: any) => void) | undefined;
	let unsubscribed = false;
	let closed = false;

	return {
		threads: { events: { list: async () => events } },
		realtime: {
			subscribe: (args: { event: string; threadId: string; callback: (e: any) => void }) => {
				realtimeCallback = args.callback;
				return () => { unsubscribed = true; };
			},
		},
		triggerRealtime: () => realtimeCallback?.({ event: "thread:changed", threadId: "thr-test" }),
		close: () => { closed = true; },
		isUnsubscribed: () => unsubscribed,
		isClosed: () => closed,
	};
}

const readyStatus = {
	ready: true,
	outcome: "READY" as const,
	reason: "ok",
	installedVersion: "0.3.0",
	candidateVersion: "0.3.0",
	hasExtensionKind: true,
	message: "Environment ready",
};

test("verify-live-g2-transport: success correlation (PASS)", async () => {
	const snapshot = makeSnapshot("epoch-1", 1);
	const mockClient = createMockLiveClient([
		{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: snapshot, threadId: "thr-test", seq: 10 },
	]);

	const promise = verifyLiveG2Transport({
		client: mockClient as any,
		readiness: readyStatus,
		threadId: "thr-test",
		expectedSessionId: "sess-1",
		timeoutMs: 1000,
	});

	setTimeout(() => mockClient.triggerRealtime(), 20);

	const result = await promise;
	assert.equal(result.outcome, "PASS");
	assert.equal(result.phase, "verified");
	assert.equal(result.snapshot?.observation.epoch, "epoch-1");
	assert.equal(mockClient.isUnsubscribed(), true);
	assert.equal(mockClient.isClosed(), true);
});

test("verify-live-g2-transport: invalid payload (FAILED)", async () => {
	const invalidSnapshot = { version: 999 };
	const mockClient = createMockLiveClient([
		{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: invalidSnapshot, threadId: "thr-test", seq: 10 },
	]);

	const result = await verifyLiveG2Transport({
		client: mockClient as any,
		readiness: readyStatus,
		threadId: "thr-test",
		timeoutMs: 150,
	});

	assert.equal(result.outcome, "FAILED");
	assert.equal(result.reason, "timeout_waiting_for_valid_snapshot");
	assert.equal(mockClient.isUnsubscribed(), true);
	assert.equal(mockClient.isClosed(), true);
});

test("verify-live-g2-transport: wrong scope (FAILED)", async () => {
	const foreignSnapshot = makeSnapshot("epoch-1", 1, {
		scope: { sessionId: "sess-foreign", rootConversationId: "1", buildId: "b-1" },
	});
	const mockClient = createMockLiveClient([
		{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: foreignSnapshot, threadId: "thr-test", seq: 10 },
	]);

	const result = await verifyLiveG2Transport({
		client: mockClient as any,
		readiness: readyStatus,
		threadId: "thr-test",
		expectedSessionId: "sess-expected",
		timeoutMs: 150,
	});

	assert.equal(result.outcome, "FAILED");
	assert.equal(result.reason, "scope_mismatch");
	assert.equal(mockClient.isUnsubscribed(), true);
	assert.equal(mockClient.isClosed(), true);
});

test("verify-live-g2-transport: timeout and cleanup (FAILED)", async () => {
	const mockClient = createMockLiveClient([]);
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
