import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Harness, ROOT_CONVERSATION_ID, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { BindingDoc, BindingIndexDoc, identityKey } from "../../src/runner/binding-docs.ts";
import { SubagentsDoc } from "../../src/runner/subagent-docs.ts";
import { getPiDurableVersion } from "../../src/runner/version.ts";

// Test-data generator only: run with exact 1.3 dependencies BEFORE the candidate dependency replacement.
if (getPiDurableVersion() !== "1.3.0") throw new Error("FIXTURE_REQUIRES_DURABLE_1_3");
const directory = fileURLToPath(new URL(".", import.meta.url));
const path = resolve(directory, "durable-1.3.sqlite");
if (existsSync(path)) throw new Error("FIXTURE_ALREADY_EXISTS");
const storage = await openNodeSqliteStorage(path);
const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
try {
 const root = await harness.root(context);
 const child = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
 const binding = { providerId: "pi-durable", sessionId: "synthetic-session", conversationId: ROOT_CONVERSATION_ID, bbThreadId: "synthetic-thread", parentThreadId: null, createdAt: 1 };
 const entryIds = await harness.commit(async (tx) => {
  const user = await tx.appendEntry(root.id, { kind: "pi.user", model: [{ role: "user", content: "migration-fixture", timestamp: 1 }] });
  const assistant = await tx.appendEntry(root.id, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "synthetic-answer" }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 }] });
  (await tx.doc(BindingDoc, root.id)).binding = binding;
  const index = await tx.doc(BindingIndexDoc);
  index.byThreadId[binding.bbThreadId] = root.id;
  index.byIdentity[identityKey(binding)] = root.id;
  (await tx.doc(SubagentsDoc, root.id)).outbox = [{ id: "synthetic-report", name: "fixture", text: "synthetic-report-body" }];
  return [user.id, assistant.id];
 }, context);
 writeFileSync(resolve(directory, "durable-1.3-manifest.json"), JSON.stringify({ sourceVersion: "1.3.0", rootId: root.id, childId: child.id, entryIds, binding, outboxIds: ["synthetic-report"] }, null, 2) + "\n");
 console.log(JSON.stringify({ sourceVersion: "1.3.0", entries: entryIds.length, rootId: root.id, childId: child.id }));
} finally { await harness.close(context); await storage.close(); }
