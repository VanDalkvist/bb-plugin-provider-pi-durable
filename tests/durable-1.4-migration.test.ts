import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { BindingDoc } from "../src/runner/binding-docs.ts";
import { SubagentsDoc } from "../src/runner/subagent-docs.ts";
import { parseConversationId } from "../src/runner/conversation-id.ts";

const manifestSchema = z.object({
	sourceVersion: z.literal("1.3.0"), rootId: z.number().int().positive(), childId: z.number().int().positive(),
	entryIds: z.array(z.number().int().positive()), outboxIds: z.array(z.string()),
	binding: z.object({ providerId: z.string(), sessionId: z.string(), conversationId: z.number(), bbThreadId: z.string(), parentThreadId: z.null(), createdAt: z.number() }),
});

test("actual 1.3 SQLite fixture opens/reopens in 1.4 preserving transcript IDs, child and adapter documents", async () => {
	const source = new URL("./fixtures/durable-1.3.sqlite", import.meta.url);
	const before = createHash("sha256").update(await readFile(source)).digest("hex");
	const manifest = manifestSchema.parse(JSON.parse(await readFile(new URL("./fixtures/durable-1.3-manifest.json", import.meta.url), "utf8")));
	const dir = await mkdtemp(join(tmpdir(), "durable-upgrade-fixture-"));
	const path = join(dir, "session.sqlite");
	await copyFile(source, path);
	try {
		for (let reopen = 0; reopen < 2; reopen++) {
			const storage = await openNodeSqliteStorage(path);
			const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
			try {
				const root = await harness.root(context);
				assert.equal(root.id, manifest.rootId);
				assert.ok(await harness.conversation(parseConversationId(manifest.childId), context));
				const entries = await root.entries({}, 256, undefined, context);
				assert.deepEqual(entries.items.map((entry) => entry.id).sort((a, b) => a - b), manifest.entryIds);
				assert.equal(entries.items.length, 2, "no empty replacement session or duplicate replay");
				assert.deepEqual((await harness.snapshot(BindingDoc, root.id, context))?.binding, manifest.binding);
				assert.deepEqual((await harness.snapshot(SubagentsDoc, root.id, context))?.outbox?.map((report) => report.id), manifest.outboxIds);
			} finally { await harness.close(context); await storage.close(context); }
		}
		assert.equal(createHash("sha256").update(await readFile(source)).digest("hex"), before, "golden synthetic fixture is never migrated in place");
	} finally { await rm(dir, { recursive: true, force: true }); }
});
