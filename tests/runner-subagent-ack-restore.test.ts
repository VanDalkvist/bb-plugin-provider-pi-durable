import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SubagentPolicyAckDoc, loadSubagentPolicyHolder } from "../src/runner/subagent-policy-ack.ts";
import { SubagentPolicyLoadError } from "../src/policy/errors.ts";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";

test("native execution ACK restore: restores persisted checkpoint from harness doc", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-policy-ack-"));
	const dbPath = path.join(tempDir, "session.sqlite");
	const registry = createRegistry();
	const models = createModels();

	try {
		const storage1 = await openNodeSqliteStorage(dbPath);
		const harness1 = await Harness.open(storage1, { models, registry }, ctx);
		const holder1 = await loadSubagentPolicyHolder(harness1);
		await holder1.setRecord({
			version: 1,
			revision: 5,
			policy: {
				mode: "configured",
				configuredProfile: { model: { provider: "test", modelId: "m5" }, thinkingLevel: "low" },
			},
		});
		await harness1.close(ctx);

		const storage2 = await openNodeSqliteStorage(dbPath);
		const harness2 = await Harness.open(storage2, { models, registry }, ctx);
		const holder2 = await loadSubagentPolicyHolder(harness2);
		const restored = holder2.getRecord();
		assert.equal(restored.revision, 5);
		assert.equal(restored.policy.mode, "configured");
		if (restored.policy.mode === "configured") {
			assert.equal(restored.policy.configuredProfile.model.modelId, "m5");
		}
		await harness2.close(ctx);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("native execution ACK: corrupt record throws typed SubagentPolicyLoadError with Zod cause", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-policy-ack-corrupt-"));
	const dbPath = path.join(tempDir, "session.sqlite");
	const registry = createRegistry();
	const models = createModels();

	try {
		const storage1 = await openNodeSqliteStorage(dbPath);
		const harness1 = await Harness.open(storage1, { models, registry }, ctx);
		await harness1.commit(async (tx) => {
			const doc = await tx.doc(SubagentPolicyAckDoc);
			doc.record = { corrupt: true, invalid: "payload" } as any;
		}, ctx);
		await harness1.close(ctx);

		const storage2 = await openNodeSqliteStorage(dbPath);
		const harness2 = await Harness.open(storage2, { models, registry }, ctx);
		try {
			await assert.rejects(
				() => loadSubagentPolicyHolder(harness2),
				(err: any) => {
					assert.ok(err instanceof SubagentPolicyLoadError, "Must be SubagentPolicyLoadError");
					assert.equal(err.code, "SUBAGENT_POLICY_LOAD_ERROR");
					assert.ok(err.cause, "Must preserve Zod cause");
					return true;
				},
			);
		} finally {
			await harness2.close(ctx);
		}
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
