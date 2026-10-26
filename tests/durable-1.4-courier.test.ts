import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness, MemoryStorage, createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { courierFor, reporterFor, courierIsIdle } from "../src/runner/subagent-delivery.ts";
import { SubagentsDoc } from "../src/runner/subagent-docs.ts";

test("courier liveness retains every nonterminal native status, including sleeping and completing", () => {
	for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) assert.equal(courierIsIdle({ state: { status } }), false, status);
	assert.equal(courierIsIdle(undefined), true);
	assert.equal(courierIsIdle({ state: { status: "terminal" } }), true);
});

test("an actual reporter queues to an existing sleeping courier without creating another courier", { timeout: 4000 }, async () => {
	const courier = courierFor(), reporter = reporterFor(courier), registry = createRegistry();
	registry.install(courier); registry.install(reporter);
	const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage("worker complete")]);
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { registry, models, now: () => 1000, onWake: () => {} }, context);
	try {
		const model = { provider: faux.provider.id, modelId: faux.getModel().id };
		const root = await harness.root(context, { agent: { model } });
		const child = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		let sleepingId: TaskId<null> | undefined;
		const asleep = new Promise<void>((resolve) => harness.subscribeCommits((publication) => {
			if (publication.changes.some((change) => change.type === "task" && change.value.id === sleepingId && change.value.state.status === "sleeping")) resolve();
		}));
		sleepingId = await harness.commit(async (tx) => {
			const id = await tx.createTask(courier, null, { ownership: { kind: "conversation" }, conversationId: root.id, background: true });
			(await tx.doc(SubagentsDoc, root.id)).courier = id; return id;
		}, context);
		harness.resume(); await asleep;
		const reportId = await harness.commit((tx) => tx.createTask(reporter, {
			key: "worker", conversationId: child.id, task: "test", requestId: "fixture-report",
		}, { ownership: { kind: "conversation" }, conversationId: root.id, background: true }), context);
		assert.equal((await harness.waitForTask(reportId, context)).state.outcome.status, "completed");
		const state = await harness.snapshot(SubagentsDoc, root.id, context);
		assert.equal(state?.courier, sleepingId);
		assert.equal(state?.outbox?.length, 1);
		assert.equal((await harness.getTask(sleepingId, context))?.state.status, "sleeping");
	} finally { await harness.close(context); await storage.close(context); }
});

test("courier durably sleeps until exact next-phase deadline and resumes same ID after reopen", { timeout: 4000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "courier-sleep-"));
	let clock = 1000;
	const courier = courierFor(), registry = createRegistry();
	registry.install(courier);
	const options = { registry, models: createModels(), now: () => clock, onWake: () => {} };
	let storage = await openNodeSqliteStorage(join(dir, "session.sqlite"));
	let harness = await Harness.open(storage, options, context);
	try {
		const root = await harness.root(context);
		let id: TaskId<null> | undefined;
		const asleep = new Promise<void>((resolve) => {
			harness.subscribeCommits((publication) => {
				if (publication.changes.some((change) => change.type === "task" && change.value.id === id && change.value.state.status === "sleeping")) resolve();
			});
		});
		id = await harness.commit(async (tx) => {
			const next = await tx.createTask(courier, null, { ownership: { kind: "conversation" }, conversationId: root.id, background: true });
			(await tx.doc(SubagentsDoc, root.id)).courier = next;
			return next;
		}, context);
		harness.resume();
		await asleep;
		const record = await harness.getTask(id, context);
		assert.equal(record?.state.status, "sleeping");
		if (record?.state.status !== "sleeping") assert.fail("courier held an invocation instead of durably sleeping");
		assert.equal(record.state.until, 1050);
		assert.deepEqual(record.state.checkpoint, { phase: "next" });
		await harness.close(context); await storage.close(context);
		storage = await openNodeSqliteStorage(join(dir, "session.sqlite"));
		harness = await Harness.open(storage, options, context);
		assert.equal((await harness.getTask(id, context))?.state.status, "sleeping");
		assert.equal((await harness.snapshot(SubagentsDoc, root.id, context))?.courier, id);
		clock = 1050;
		harness.resume();
		const receipt = await harness.waitForTask(id, context);
		assert.equal(receipt.state.outcome.status, "completed");
		assert.equal((await harness.snapshot(SubagentsDoc, root.id, context))?.courier, undefined);
	} finally {
		await harness.close(context); await storage.close(context);
		await rm(dir, { recursive: true, force: true });
	}
});
