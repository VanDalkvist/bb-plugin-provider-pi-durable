import { subscribeRuntimeGraph } from "../../src/ui/runtime-graph/subscription.ts";
import { checkProviderReadiness } from "./readiness.mjs";
import { createLiveTransportClient } from "./client.mjs";

export async function verifyLiveG2Transport(options = {}) {
	const {
		threadId,
		conversationId,
		expectedSessionId,
		expectedRootConversationId,
		timeoutMs = 15000,
	} = options;

	const readiness = options.readiness ?? await checkProviderReadiness(options);
	const client = options.client ?? createLiveTransportClient(options);

	if (!readiness.ready) {
		client.close?.();
		return {
			outcome: "BLOCKED",
			phase: "readiness",
			reason: readiness.reason,
			message: readiness.message,
			installedVersion: readiness.installedVersion,
			candidateVersion: readiness.candidateVersion,
			hasExtensionKind: readiness.hasExtensionKind,
		};
	}

	if (!threadId) {
		client.close?.();
		return {
			outcome: "BLOCKED",
			phase: "precheck",
			reason: "missing_test_thread",
			message: "No test threadId provided for live G2 verification. Provide --thread <id>.",
			installedVersion: readiness.installedVersion,
			candidateVersion: readiness.candidateVersion,
		};
	}

	return new Promise((resolve) => {
		let settled = false;
		let realtimeNotified = false;
		let unsubscribeGraph = undefined;
		let unsubscribeRealtime = undefined;
		let timeoutTimer = undefined;

		let lastEpoch = "";
		let lastRevision = -1;

		const cleanup = () => {
			if (timeoutTimer !== undefined) {
				clearTimeout(timeoutTimer);
				timeoutTimer = undefined;
			}
			try {
				unsubscribeGraph?.();
			} catch {}
			try {
				unsubscribeRealtime?.();
			} catch {}
			try {
				client.close?.();
			} catch {}
		};

		const finish = (result) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		timeoutTimer = setTimeout(() => {
			finish({
				outcome: "FAILED",
				phase: "observation",
				reason: "timeout_waiting_for_valid_snapshot",
				message: `Timed out after ${timeoutMs}ms waiting for verified runtime graph snapshot on thread ${threadId}.`,
				realtimeNotified,
				lastEpoch: lastEpoch || null,
				lastRevision: lastRevision >= 0 ? lastRevision : null,
			});
		}, timeoutMs);

		unsubscribeRealtime = client.realtime?.subscribe({
			event: "thread:changed",
			threadId,
			callback: () => {
				realtimeNotified = true;
			},
		});

		unsubscribeGraph = subscribeRuntimeGraph(client, {
			threadId,
			conversationId,
			debounceMs: 25,
			onSnapshot: (snapshot) => {
				if (expectedSessionId && snapshot.scope.sessionId !== expectedSessionId) {
					finish({
						outcome: "FAILED",
						phase: "scope_validation",
						reason: "scope_mismatch",
						message: `Snapshot sessionId mismatch: expected ${expectedSessionId}, received ${snapshot.scope.sessionId}`,
						snapshot,
					});
					return;
				}

				if (expectedRootConversationId && snapshot.scope.rootConversationId !== expectedRootConversationId) {
					finish({
						outcome: "FAILED",
						phase: "scope_validation",
						reason: "scope_mismatch",
						message: `Snapshot rootConversationId mismatch: expected ${expectedRootConversationId}, received ${snapshot.scope.rootConversationId}`,
						snapshot,
					});
					return;
				}

				const { epoch, revision } = snapshot.observation;
				if (lastEpoch !== "" && epoch < lastEpoch) {
					return;
				}
				if (epoch === lastEpoch && revision <= lastRevision) {
					return;
				}

				lastEpoch = epoch;
				lastRevision = revision;

				finish({
					outcome: "PASS",
					phase: "verified",
					reason: "ok",
					message: `Successfully verified live G2 transport for thread ${threadId} (epoch=${epoch}, rev=${revision}).`,
					snapshot,
					realtimeNotified,
					installedVersion: readiness.installedVersion,
					candidateVersion: readiness.candidateVersion,
				});
			},
			onStatusChange: (status) => {
				if (status === "unavailable" && !settled) {
					// May become available once event arrives, keep waiting until timeout
				}
			},
		});
	});
}
