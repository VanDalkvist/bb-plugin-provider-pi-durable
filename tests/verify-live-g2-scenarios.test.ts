import test from "node:test";
import assert from "node:assert/strict";
import { verifyLiveG2Transport } from "../scripts/g2-transport/verifier.mjs";
import { checkProviderReadiness } from "../scripts/g2-transport/readiness.mjs";
import type { RuntimeGraphSnapshot } from "../src/runtime-graph/types.ts";

function makeSnapshot(epoch: string, revision: number, overrides?: Partial<RuntimeGraphSnapshot>): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "sess-1", rootConversationId: "1", buildId: "b-1" },
		observation: { epoch, revision, observedAt: 1000 + revision, completeness: "complete" },
		nodes: {}, conversations: { "1": { id: 1 } }, receipts: [], stats: { liveCount: 0, terminalCount: 0, totalCount: 0 },
		...overrides,
	};
}

function createDynamicMockClient(initialEvents: any[] = []) {
	let events = [...initialEvents];
	const realtimeCallbacks = new Set<(event: any) => void>();
	let unsubscribed = false, closed = false;
	const subscribe = (args: { event: string; threadId: string; callback: (e: any) => void }) => {
		realtimeCallbacks.add(args.callback);
		return () => { realtimeCallbacks.delete(args.callback); unsubscribed = true; };
	};
	return {
		threads: { events: { list: async () => events } },
		subscribe,
		realtime: {
			subscribe,
		},
		appendEvent: (event: any) => { events.unshift(event); },
		triggerRealtime: () => { for (const cb of realtimeCallbacks) cb({ event: "thread:changed", threadId: "thr-test" }); },
		close: () => { closed = true; },
		isUnsubscribed: () => unsubscribed,
		isClosed: () => closed,
	};
}

function createReadinessFetch(version: string, hasExtKind: boolean) {
	return async (url: string) => {
		if (url.includes("/api/v1/plugins")) {
			return { ok: true, status: 200, json: async () => ({ plugins: [{ id: "provider-pi-durable", version, enabled: true, status: "running" }] }) } as any;
		}
		if (url.includes("/api/v1/system/providers")) {
			return { ok: true, status: 200, json: async () => [{ id: "pi-durable", pluginId: "provider-pi-durable", available: true, extensionKinds: hasExtKind ? { "provider-pi-durable/runtime-graph": { state: true } } : undefined }] } as any;
		}
		throw new Error("unexpected url: " + url);
	};
}

const readyStatus = {
	ready: true, outcome: "UNVERIFIED" as const, reason: "runtime_unverified",
	installedVersion: "0.3.0", candidateVersion: "0.3.0", hasExtensionKind: true,
	installed: { version: "0.3.0", status: "verified" }, restart: { status: "unverified" }, runtime: { status: "unverified" },
	message: "Precheck ok",
};

test("verify-live-g2-scenarios: stale or out-of-order revision is dropped (FAILED)", async () => {
	const snapBaseline = makeSnapshot("epoch-1", 2);
	const snapStale = makeSnapshot("epoch-1", 1);
	const mockClient = createDynamicMockClient([
		{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: snapBaseline, threadId: "thr-test", seq: 20 },
	]);

	const result = await verifyLiveG2Transport({
		client: mockClient as any, readiness: readyStatus, threadId: "thr-test", expectedSessionId: "sess-1", timeoutMs: 100,
		trigger: async () => {
			mockClient.appendEvent({ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: snapStale, threadId: "thr-test", seq: 21 });
			mockClient.triggerRealtime();
		},
	});
	assert.equal(result.outcome, "FAILED");
	assert.equal(result.reason, "timeout_waiting_for_valid_snapshot");
});

test("verify-live-g2-scenarios: epoch reset with valid causal progression (PASS)", async () => {
	const snapBaseline = makeSnapshot("epoch-1", 2, { observation: { epoch: "epoch-1", revision: 2, observedAt: 1000, completeness: "complete" } });
	const snapNewEpoch = makeSnapshot("epoch-2", 1, { observation: { epoch: "epoch-2", revision: 1, observedAt: 2000, completeness: "complete" } });
	const mockClient = createDynamicMockClient([
		{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: snapBaseline, threadId: "thr-test", seq: 10 },
	]);

	const result = await verifyLiveG2Transport({
		client: mockClient as any, readiness: readyStatus, threadId: "thr-test", expectedSessionId: "sess-1", timeoutMs: 1000,
		trigger: async () => {
			mockClient.appendEvent({ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: snapNewEpoch, threadId: "thr-test", seq: 20 });
			mockClient.triggerRealtime();
		},
	});
	assert.equal(result.outcome, "PASS");
	assert.equal(result.snapshot?.observation.epoch, "epoch-2");
	assert.equal(result.snapshot?.observation.revision, 1);
});

test("verify-live-g2-scenarios: epoch reset without causal link (older timestamp) is dropped (FAILED)", async () => {
	const snapBaseline = makeSnapshot("epoch-current", 2, { observation: { epoch: "epoch-current", revision: 2, observedAt: 5000, completeness: "complete" } });
	const snapOlderEpoch = makeSnapshot("epoch-ancient", 1, { observation: { epoch: "epoch-ancient", revision: 1, observedAt: 1000, completeness: "complete" } });
	const mockClient = createDynamicMockClient([
		{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: snapBaseline, threadId: "thr-test", seq: 10 },
	]);

	const result = await verifyLiveG2Transport({
		client: mockClient as any, readiness: readyStatus, threadId: "thr-test", expectedSessionId: "sess-1", timeoutMs: 100,
		trigger: async () => {
			mockClient.appendEvent({ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: snapOlderEpoch, threadId: "thr-test", seq: 20 });
			mockClient.triggerRealtime();
		},
	});
	assert.equal(result.outcome, "FAILED");
	assert.equal(result.reason, "timeout_waiting_for_valid_snapshot");
});

test("verify-live-g2-scenarios: wrong session scope fails with scope_mismatch (FAILED)", async () => {
	const snapForeign = makeSnapshot("epoch-1", 1, { scope: { sessionId: "foreign-session", rootConversationId: "1", buildId: "b-1" } });
	const mockClient = createDynamicMockClient([]);

	const result = await verifyLiveG2Transport({
		client: mockClient as any, readiness: readyStatus, threadId: "thr-test", expectedSessionId: "expected-session", timeoutMs: 1000,
		trigger: async () => {
			mockClient.appendEvent({ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: snapForeign, threadId: "thr-test", seq: 1 });
			mockClient.triggerRealtime();
		},
	});
	assert.equal(result.outcome, "FAILED");
	assert.equal(result.reason, "scope_mismatch");
});

test("verify-live-g2-scenarios: checkProviderReadiness returns BLOCKED when version is 0.2.53", async () => {
	const mockFetch = createReadinessFetch("0.2.53", false);
	const readiness = await checkProviderReadiness({ serverUrl: "http://mock-server:38886", fetchFn: mockFetch });
	assert.equal(readiness.ready, false);
	assert.equal(readiness.outcome, "BLOCKED");
	assert.equal(readiness.reason, "installed_version_outdated");
	assert.equal(readiness.installedVersion, "0.2.53");
	assert.equal(readiness.installed?.status, "outdated");
	assert.equal(readiness.runtime?.status, "blocked");
});

test("verify-live-g2-scenarios: checkProviderReadiness returns UNVERIFIED with split statuses when version >= 0.3.0", async () => {
	const mockFetch = createReadinessFetch("0.3.0", true);
	const readiness = await checkProviderReadiness({ serverUrl: "http://mock-server:38886", fetchFn: mockFetch });
	assert.equal(readiness.ready, true);
	assert.equal(readiness.outcome, "UNVERIFIED");
	assert.equal(readiness.reason, "runtime_unverified");
	assert.equal(readiness.installedVersion, "0.3.0");
	assert.equal(readiness.hasExtensionKind, true);
	assert.equal(readiness.installed?.status, "verified");
	assert.equal(readiness.restart?.status, "unverified");
	assert.equal(readiness.runtime?.status, "unverified");
});
