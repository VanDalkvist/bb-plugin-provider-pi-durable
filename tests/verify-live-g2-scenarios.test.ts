import test from "node:test";
import assert from "node:assert/strict";
import { verifyLiveG2Transport } from "../scripts/g2-transport/verifier.mjs";
import { checkProviderReadiness } from "../scripts/g2-transport/readiness.mjs";
import type { RuntimeGraphSnapshot } from "../src/runtime-graph/types.ts";

function makeSnapshot(epoch: string, revision: number): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "sess-1", rootConversationId: "1", buildId: "b-1" },
		observation: { epoch, revision, observedAt: 1000 + revision, completeness: "complete" },
		nodes: {},
		conversations: { "1": { id: 1 } },
		receipts: [],
		stats: { liveCount: 0, terminalCount: 0, totalCount: 0 },
	};
}

function createMockLiveClient(events: any[]) {
	let unsubscribed = false;
	let closed = false;
	return {
		threads: { events: { list: async () => events } },
		realtime: { subscribe: () => () => { unsubscribed = true; } },
		close: () => { closed = true; },
		isUnsubscribed: () => unsubscribed,
		isClosed: () => closed,
	};
}

function createReadinessFetch(version: string, hasExtKind: boolean) {
	return async (url: string) => {
		if (url.includes("/api/v1/plugins")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					plugins: [{ id: "provider-pi-durable", version, enabled: true, status: "running" }],
				}),
			} as any;
		}
		if (url.includes("/api/v1/system/providers")) {
			return {
				ok: true,
				status: 200,
				json: async () => [
					{
						id: "pi-durable",
						pluginId: "provider-pi-durable",
						available: true,
						extensionKinds: hasExtKind ? { "provider-pi-durable/runtime-graph": { state: true } } : undefined,
					},
				],
			} as any;
		}
		throw new Error("unexpected url: " + url);
	};
}

test("verify-live-g2-scenarios: stale or out-of-order revisions are dropped (PASS)", async () => {
	const snapV2 = makeSnapshot("epoch-1", 2);
	const snapV1 = makeSnapshot("epoch-1", 1);
	const mockClient = createMockLiveClient([
		{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: snapV2, threadId: "thr-test", seq: 20 },
		{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: snapV1, threadId: "thr-test", seq: 10 },
	]);
	const readyStatus = {
		ready: true,
		outcome: "READY" as const,
		reason: "ok",
		installedVersion: "0.3.0",
		candidateVersion: "0.3.0",
		hasExtensionKind: true,
		message: "Environment ready",
	};
	const result = await verifyLiveG2Transport({
		client: mockClient as any,
		readiness: readyStatus,
		threadId: "thr-test",
		timeoutMs: 1000,
	});
	assert.equal(result.outcome, "PASS");
	assert.equal(result.snapshot?.observation.revision, 2);
	assert.equal(mockClient.isUnsubscribed(), true);
	assert.equal(mockClient.isClosed(), true);
});

test("verify-live-g2-scenarios: explicit blocked environment when version < 0.3.0 (BLOCKED)", async () => {
	const blockedStatus = {
		ready: false,
		outcome: "BLOCKED" as const,
		reason: "installed_version_outdated",
		installedVersion: "0.2.53",
		candidateVersion: "0.3.0",
		hasExtensionKind: false,
		message: "BB runtime has provider-pi-durable v0.2.53 installed.",
	};
	const mockClient = createMockLiveClient([]);
	const result = await verifyLiveG2Transport({
		client: mockClient as any,
		readiness: blockedStatus,
		threadId: "thr-test",
		timeoutMs: 100,
	});
	assert.equal(result.outcome, "BLOCKED");
	assert.equal(result.reason, "installed_version_outdated");
	assert.equal(result.installedVersion, "0.2.53");
	assert.equal(mockClient.isClosed(), true);
});

test("verify-live-g2-scenarios: checkProviderReadiness returns BLOCKED when version is 0.2.53", async () => {
	const mockFetch = createReadinessFetch("0.2.53", false);
	const readiness = await checkProviderReadiness({ serverUrl: "http://mock-server:38886", fetchFn: mockFetch });
	assert.equal(readiness.ready, false);
	assert.equal(readiness.outcome, "BLOCKED");
	assert.equal(readiness.reason, "installed_version_outdated");
	assert.equal(readiness.installedVersion, "0.2.53");
	assert.equal(readiness.hasExtensionKind, false);
});

test("verify-live-g2-scenarios: checkProviderReadiness returns READY when version >= 0.3.0 with extensionKind", async () => {
	const mockFetch = createReadinessFetch("0.3.0", true);
	const readiness = await checkProviderReadiness({ serverUrl: "http://mock-server:38886", fetchFn: mockFetch });
	assert.equal(readiness.ready, true);
	assert.equal(readiness.outcome, "READY");
	assert.equal(readiness.installedVersion, "0.3.0");
	assert.equal(readiness.hasExtensionKind, true);
});
