import test from "node:test";
import assert from "node:assert/strict";
import { createSubagentPolicyHolder } from "../src/runner/subagent-policy-state.ts";
import { handleActiveSessionCommand } from "../src/runner/session-commands.ts";
import type { SubagentPolicyRecord } from "../src/policy/types.ts";

test("session-commands: canonical set_subagent_policy rejects legacy body and accepts canonical record", async () => {
	const persisted: SubagentPolicyRecord[] = [];
	const holder = createSubagentPolicyHolder({
		persist: async (rec) => {
			persisted.push(rec);
		},
	});

	const durable: any = {
		subagentPolicyHolder: holder,
		view: { current: () => ({ conversation: { docs: {} } }) },
	};

	let lastSuccess: { id?: string; command?: string } | undefined;
	let lastError: { id?: string; command?: string; message?: string } | undefined;

	const responder = {
		success: (id: string | undefined, command: string) => {
			lastSuccess = { id, command };
		},
		error: (id: string | undefined, command: string, message: string) => {
			lastError = { id, command, message };
		},
	};

	const modelRuntime = { getAvailableSnapshot: () => [] };

	// 1. Negative test: Legacy body with `policy` field instead of `policyRecord` must be refused
	lastSuccess = undefined;
	lastError = undefined;
	await handleActiveSessionCommand(
		{ type: "set_subagent_policy", id: "legacy-1", policy: { version: 1, revision: 1, policy: { mode: "inherit" } } } as any,
		durable,
		modelRuntime as any,
		{} as any,
		responder,
	);
	assert.ok(lastError, "Legacy command with 'policy' must be rejected");
	assert.equal(lastSuccess, undefined);
	assert.equal(holder.getRecord().revision, 0, "Holder must not be updated by legacy command");

	// 2. Negative test: Invalid policyRecord must be refused
	lastSuccess = undefined;
	lastError = undefined;
	await handleActiveSessionCommand(
		{ type: "set_subagent_policy", id: "invalid-1", policyRecord: { bogus: true } } as any,
		durable,
		modelRuntime as any,
		{} as any,
		responder,
	);
	assert.ok(lastError, "Invalid policyRecord must be rejected");
	assert.equal(lastSuccess, undefined);
	assert.equal(holder.getRecord().revision, 0, "Holder must not be updated by invalid record");

	// 3. Positive test: Canonical policyRecord must be accepted
	const canonicalRecord: SubagentPolicyRecord = {
		version: 1,
		revision: 1,
		policy: { mode: "inherit" },
	};

	lastSuccess = undefined;
	lastError = undefined;
	await handleActiveSessionCommand(
		{ type: "set_subagent_policy", id: "canonical-1", policyRecord: canonicalRecord },
		durable,
		modelRuntime as any,
		{} as any,
		responder,
	);
	assert.equal(lastError, undefined);
	assert.ok(lastSuccess, "Canonical command must succeed");
	assert.equal(holder.getRecord().revision, 1, "Holder must be updated to revision 1");

	assert.equal(persisted.length, 1);
	assert.deepEqual(persisted[0], canonicalRecord);
});
