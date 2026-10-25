import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileSessionOptions, type ReconcilableSession } from "../src/host/session-reconcile.ts";
import type { SubagentPolicyRecord } from "../src/policy/types.ts";

describe("Host Subagent Policy Delivery (Task 6)", () => {
	it("first desired snapshot is sent even when already in session.options.providerOptions", async () => {
		const policyRecord: SubagentPolicyRecord = {
			version: 1,
			revision: 1,
			policy: {
				mode: "configured",
				configuredProfile: {
					model: {
						provider: "antigravity",
						modelId: "gemini-3.8-flash",
					},
					thinkingLevel: "high",
				},
			},
		};

		let sentPolicy: SubagentPolicyRecord | undefined;
		let ackRevision: number | undefined = undefined;

		const mockSession: ReconcilableSession = {
			options: {
				providerOptions: {
					subagentPolicy: policyRecord,
				},
			},
			setSubagentPolicy: async (record: SubagentPolicyRecord) => {
				sentPolicy = record;
				ackRevision = record.revision;
			},
			getAcknowledgedSubagentPolicyRevision: () => ackRevision,
		};

		assert.equal(mockSession.getAcknowledgedSubagentPolicyRevision?.(), undefined);
		await reconcileSessionOptions(mockSession, undefined);

		assert.deepEqual(sentPolicy, policyRecord);
		assert.equal(mockSession.getAcknowledgedSubagentPolicyRevision?.(), 1);
	});

	it("changed revision in incoming options is sent and updates acknowledged revision", async () => {
		let sentPolicy: SubagentPolicyRecord | undefined;
		let ackRevision: number | undefined = 1;

		const initialRecord: SubagentPolicyRecord = {
			version: 1,
			revision: 1,
			policy: { mode: "inherit" },
		};

		const updatedRecord: SubagentPolicyRecord = {
			version: 1,
			revision: 2,
			policy: {
				mode: "configured",
				configuredProfile: {
					model: {
						provider: "openai",
						modelId: "gpt-4o",
					},
					thinkingLevel: "off",
				},
			},
		};

		const mockSession: ReconcilableSession = {
			options: {
				providerOptions: {
					subagentPolicy: initialRecord,
				},
			},
			setSubagentPolicy: async (record: SubagentPolicyRecord) => {
				sentPolicy = record;
				ackRevision = record.revision;
			},
			getAcknowledgedSubagentPolicyRevision: () => ackRevision,
		};

		// 1. Same revision: not resent
		await reconcileSessionOptions(mockSession, {
			providerOptions: { subagentPolicy: initialRecord },
		});
		assert.equal(sentPolicy, undefined);

		// 2. Higher revision: sent and acknowledged
		await reconcileSessionOptions(mockSession, {
			providerOptions: { subagentPolicy: updatedRecord },
		});
		assert.deepEqual(sentPolicy, updatedRecord);
		assert.equal(ackRevision, 2);
	});

	it("failed ack does not update cache or acknowledged revision and throws before prompt", async () => {
		let ackRevision: number | undefined = undefined;

		const failingSession: ReconcilableSession = {
			options: {
				providerOptions: {
					subagentPolicy: { version: 1, revision: 1, policy: { mode: "inherit" } },
				},
			},
			setSubagentPolicy: async () => {
				throw new Error("RPC set_subagent_policy connection failure");
			},
			getAcknowledgedSubagentPolicyRevision: () => ackRevision,
		};

		await assert.rejects(
			async () => {
				await reconcileSessionOptions(failingSession, undefined);
			},
			{ message: "RPC set_subagent_policy connection failure" },
		);

		assert.equal(failingSession.getAcknowledgedSubagentPolicyRevision?.(), undefined);
	});
});
