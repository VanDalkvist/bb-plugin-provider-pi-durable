import { subscribeRuntimeGraph } from "../../src/ui/runtime-graph/subscription.ts";
import { readRuntimeGraphSnapshot } from "../../src/ui/runtime-graph/read.ts";
import { checkProviderReadiness } from "./readiness.mjs";
import { createLiveTransportClient } from "./client.mjs";

export async function verifyLiveG2Transport(options = {}) {
	const { threadId, conversationId, expectedSessionId, expectedRootConversationId, timeoutMs = 15000, trigger, onReady } = options;
	const readiness = options.readiness ?? await checkProviderReadiness(options);
	const client = options.client ?? createLiveTransportClient(options);
	const meta = { installedVersion: readiness.installedVersion, candidateVersion: readiness.candidateVersion, installed: readiness.installed, restart: readiness.restart, runtime: readiness.runtime };

	if (!readiness.ready) {
		client.close?.();
		return { outcome: "BLOCKED", phase: "readiness", reason: readiness.reason, message: readiness.message, hasExtensionKind: readiness.hasExtensionKind, ...meta };
	}
	if (!threadId) {
		client.close?.();
		return { outcome: "BLOCKED", phase: "precheck", reason: "missing_test_thread", message: "No test threadId provided for live G2 verification. Provide --thread <id>.", ...meta };
	}
	if (expectedSessionId !== undefined && (typeof expectedSessionId !== "string" || expectedSessionId.trim() === "")) {
		client.close?.();
		return { outcome: "FAILED", phase: "precheck", reason: "invalid_expected_session", message: "expectedSessionId must be a non-empty string when provided." };
	}

	return new Promise((resolve) => {
		let settled = false;
		let baselineReady = false;
		let baselineSeq = null, baselineEpoch = null, baselineRevision = -1, baselineObservedAt = 0;
		let realtimeNotified = false, realtimeEventCount = 0;
		let lastEpoch = "", lastRevision = -1, lastObservedAt = 0;
		let unsubscribeGraph, unsubscribeRealtime, timeoutTimer;

		const cleanup = () => {
			if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
			try { unsubscribeGraph?.(); } catch {}
			try { unsubscribeRealtime?.(); } catch {}
			try { client.close?.(); } catch {}
		};
		const finish = (result) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		timeoutTimer = setTimeout(() => {
			finish({
				outcome: "FAILED", phase: "observation", reason: "timeout_waiting_for_valid_snapshot",
				message: `Timed out after ${timeoutMs}ms waiting for verified runtime graph snapshot on thread ${threadId}.`,
				realtimeNotified, realtimeEventCount, lastEpoch: lastEpoch || null, lastRevision: lastRevision >= 0 ? lastRevision : null,
				baselineSeq, baselineEpoch, baselineRevision,
			});
		}, timeoutMs);

		unsubscribeRealtime = client.realtime?.subscribe({
			event: "thread:changed", threadId,
			callback: () => {
				if (!baselineReady) return;
				realtimeNotified = true;
				realtimeEventCount++;
			},
		});

		unsubscribeGraph = subscribeRuntimeGraph(client, {
			threadId, conversationId, debounceMs: 25,
			onSnapshot: (snapshot) => {
				if (!baselineReady) return;
				if (expectedSessionId && snapshot.scope.sessionId !== expectedSessionId) {
					return finish({ outcome: "FAILED", phase: "scope_validation", reason: "scope_mismatch", message: `Snapshot sessionId mismatch: expected ${expectedSessionId}, received ${snapshot.scope.sessionId}`, snapshot });
				}
				if (expectedRootConversationId && snapshot.scope.rootConversationId !== expectedRootConversationId) {
					return finish({ outcome: "FAILED", phase: "scope_validation", reason: "scope_mismatch", message: `Snapshot rootConversationId mismatch: expected ${expectedRootConversationId}, received ${snapshot.scope.rootConversationId}`, snapshot });
				}
				const { epoch, revision, observedAt } = snapshot.observation;
				if (baselineEpoch !== null) {
					if (epoch === baselineEpoch && revision <= baselineRevision) return;
					if (epoch !== baselineEpoch && (observedAt < baselineObservedAt || revision < 1)) return;
				}
				if (lastEpoch !== "") {
					if (epoch === lastEpoch && revision <= lastRevision) return;
					if (epoch !== lastEpoch && observedAt < lastObservedAt) return;
				}
				if (!realtimeNotified) return;

				lastEpoch = epoch;
				lastRevision = revision;
				lastObservedAt = observedAt;
				finish({
					outcome: "PASS", phase: "verified", reason: "ok",
					message: `Successfully verified live G2 transport for thread ${threadId} (epoch=${epoch}, rev=${revision}, realtime=true).`,
					snapshot, realtimeNotified: true, ...meta,
					runtime: { status: "verified", message: "Live transport and realtime delivery verified via fresh native emission." },
				});
			},
			onStatusChange: (status) => {
				if (status === "unavailable" && !settled) {}
			},
		});

		const initBaseline = async () => {
			try {
				const initial = await readRuntimeGraphSnapshot(client, threadId, { conversationId });
				if (initial.status === "ok") {
					baselineEpoch = initial.snapshot.observation.epoch;
					baselineRevision = initial.snapshot.observation.revision;
					baselineObservedAt = initial.snapshot.observation.observedAt;
					baselineSeq = initial.seq ?? null;
				}
			} catch {}
			baselineReady = true;
			onReady?.({ baselineSeq, baselineEpoch, baselineRevision, baselineObservedAt });
			if (typeof trigger === "function") {
				try {
					await trigger();
				} catch (err) {
					finish({ outcome: "FAILED", phase: "trigger", reason: "trigger_failed", message: `Trigger execution failed: ${err instanceof Error ? err.message : String(err)}` });
				}
			}
		};

		void initBaseline();
	});
}
