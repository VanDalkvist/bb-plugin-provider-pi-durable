import test from "node:test";
import assert from "node:assert/strict";
import { createSubagentPolicyHolder } from "../src/runner/subagent-policy-state.ts";
import { loadSubagentPolicyHolder } from "../src/runner/subagent-policy-ack.ts";
import { handleActiveSessionCommand } from "../src/runner/session-commands.ts";
import { parseConversationId } from "../src/runner/session-commands.ts";
import { SubagentRevisionConflictError } from "../src/policy/errors.ts";
import type { SubagentPolicyRecord } from "../src/policy/types.ts";
import { Harness, MemoryStorage, ROOT_CONVERSATION_ID, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";

test("holder instance isolation: separate holders maintain independent state", async () => {
	const holder1 = createSubagentPolicyHolder({
		persist: async () => {},
	});
	const holder2 = createSubagentPolicyHolder({
		persist: async () => {},
	});

	await holder1.setRecord({
		version: 1,
		revision: 1,
		policy: {
			mode: "configured",
			configuredProfile: {
				model: { provider: "prov", modelId: "mod" },
				thinkingLevel: "high",
			},
		},
	});

	assert.equal(holder1.getRecord().policy.mode, "configured");
	assert.equal(holder2.getRecord().policy.mode, "inherit");
});

test("monotonic revisions: idempotent retry, conflict, downgrade, and recovery", async () => {
	let persistCount = 0;
	let shouldFail = false;
	const persistedRecords: SubagentPolicyRecord[] = [];

	const holder = createSubagentPolicyHolder({
		persist: async (rec) => {
			if (shouldFail) throw new Error("Disk full");
			persistCount++;
			persistedRecords.push(rec);
		},
	});

	// Default initialization has revision 0, inherit, no timestamp
	const initial = holder.getRecord();
	assert.equal(initial.version, 1);
	assert.equal(initial.revision, 0);
	assert.equal(initial.policy.mode, "inherit");
	assert.equal(initial.updatedAt, undefined);

	// Monotonic increment to revision 1
	const rec1: SubagentPolicyRecord = {
		version: 1,
		revision: 1,
		policy: {
			mode: "configured",
			configuredProfile: { model: { provider: "p", modelId: "m1" }, thinkingLevel: "medium" },
		},
	};
	await holder.setRecord(rec1);
	assert.equal(persistCount, 1);
	assert.equal(holder.getRecord().revision, 1);

	// Identical payload at same revision is no-write idempotent
	await holder.setRecord(rec1);
	assert.equal(persistCount, 1, "Identical same-revision record must not trigger persist");

	// Different payload at same revision is conflict
	const rec1Conflict: SubagentPolicyRecord = { version: 1, revision: 1, policy: { mode: "inherit" } };
	await assert.rejects(
		() => holder.setRecord(rec1Conflict),
		(err: any) => err instanceof SubagentRevisionConflictError || err.code === "REVISION_CONFLICT",
	);

	// Lower revision is rejected
	const rec0: SubagentPolicyRecord = { version: 1, revision: 0, policy: { mode: "inherit" } };
	await assert.rejects(
		() => holder.setRecord(rec0),
		(err: any) => err instanceof SubagentRevisionConflictError || err.code === "REVISION_CONFLICT",
	);

	// Failed persist keeps old cache intact, queue recovers
	shouldFail = true;
	const rec2: SubagentPolicyRecord = { version: 1, revision: 2, policy: { mode: "inherit" } };
	await assert.rejects(() => holder.setRecord(rec2), /Disk full/);
	assert.equal(holder.getRecord().revision, 1, "Cache must not update on persist failure");

	shouldFail = false;
	await holder.setRecord(rec2);
	assert.equal(holder.getRecord().revision, 2, "Queue must recover after failure");
});

test("session-commands: set_subagent_policy updates holder and persists before prompt", async () => {
	const storage = new MemoryStorage();
	const registry = createRegistry();
	const models = createModels();
	const harness = await Harness.open(storage, { models, registry }, ctx);
	const holder = await loadSubagentPolicyHolder(harness);

	const durable: any = {
		harness,
		subagentPolicyHolder: holder,
		view: { current: () => ({ conversation: { docs: {} } }) },
	};

	let successRes: any;
	let errorRes: any;
	const responder = {
		success: (_id: any, _cmd: any, data: any) => { successRes = data ?? true; },
		error: (_id: any, _cmd: any, err: any) => { errorRes = err; },
	};

	const policyPayload: SubagentPolicyRecord = {
		version: 1,
		revision: 1,
		policy: { mode: "inherit" },
	};

	await handleActiveSessionCommand(
		{ type: "set_subagent_policy", id: "c1", policyRecord: policyPayload },
		durable,
		models as any,
		{} as any,
		responder,
	);

	assert.ok(successRes, "Command must succeed");
	assert.equal(errorRes, undefined);
	assert.equal(holder.getRecord().revision, 1);

	await harness.close(ctx);
});

test("session-commands: targeted child get_state reads child agent without altering root", async () => {
	const storage = new MemoryStorage();
	const registry = createRegistry();
	const models = createModels();
	const harness = await Harness.open(storage, { models, registry }, ctx);

	const root = await harness.root(ctx, { agent: { model: { provider: "root-p", modelId: "root-m" } } });
	const childConv = await harness.createConversation({ ownership: { kind: "session" } }, ctx);
	await childConv.configure({ model: { provider: "child-p", modelId: "child-m" }, thinkingLevel: "high" }, ctx);

	let rootStateRes: any;
	let childStateRes: any;
	const responder = {
		success: (_id: any, _cmd: any, data: any) => {
			if (_id === "root") rootStateRes = data;
			if (_id === "child") childStateRes = data;
		},
		error: () => {},
	};

	const durable: any = {
		harness,
		view: {
			current: () => ({
				conversation: { docs: { "pi.agent": { model: { provider: "root-p", modelId: "root-m" } } } },
			}),
		},
	};

	await handleActiveSessionCommand(
		{ type: "get_state", id: "root", conversationId: root.id },
		durable,
		models as any,
		{} as any,
		responder,
	);
	await handleActiveSessionCommand(
		{ type: "get_state", id: "child", conversationId: childConv.id },
		durable,
		models as any,
		{} as any,
		responder,
	);

	assert.equal(rootStateRes.model.modelId, "root-m");
	assert.equal(childStateRes.model.modelId, "child-m");
	assert.equal(childStateRes.thinkingLevel, "high");

	await harness.close(ctx);
});

