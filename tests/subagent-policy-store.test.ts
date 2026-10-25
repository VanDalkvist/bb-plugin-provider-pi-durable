import test from "node:test";
import assert from "node:assert/strict";
import { SubagentPolicyStore } from "../src/policy/store.ts";
import {
  SubagentPolicyLoadError,
  SubagentRevisionConflictError,
} from "../src/policy/errors.ts";
import type { SubagentPolicy, SubagentPolicyRecord } from "../src/policy/types.ts";

function createMockKv(initial?: Record<string, unknown>) {
  const map = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return structuredClone(map.get(key)) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      map.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
    async list(): Promise<string[]> {
      return Array.from(map.keys());
    },
    _raw: map,
  };
}

test("SubagentPolicyStore: cold hydrate initializes canonical inherit default without timestamp", async () => {
  const kv = createMockKv();
  const store = new SubagentPolicyStore(kv);
  const record = await store.hydrate();

  assert.deepEqual(record, {
    version: 1,
    revision: 0,
    policy: { mode: "inherit" },
  });
  assert.equal(record.updatedAt, undefined);
  assert.deepEqual(store.getRecord(), record);
});

test("SubagentPolicyStore: serialized CAS setPolicy increments revision and injects clock", async () => {
  const kv = createMockKv();
  const fixedTime = "2026-10-25T14:30:00.000Z";
  const store = new SubagentPolicyStore(kv, { clock: () => fixedTime });
  await store.hydrate();

  const newPolicy: SubagentPolicy = {
    mode: "configured",
    configuredProfile: {
      model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
      thinkingLevel: "high",
    },
  };

  const updated = await store.setPolicy(newPolicy, 0);
  assert.deepEqual(updated, {
    version: 1,
    revision: 1,
    updatedAt: fixedTime,
    policy: newPolicy,
  });
  assert.deepEqual(store.getRecord(), updated);

  const rawInKv = await kv.get<SubagentPolicyRecord>("subagent.policy.v1");
  assert.deepEqual(rawInKv, updated);
});

test("SubagentPolicyStore: defensive clones prevent caller mutation", async () => {
  const kv = createMockKv();
  const store = new SubagentPolicyStore(kv);
  await store.hydrate();

  const snap1 = store.getRecord();
  (snap1 as any).revision = 999;
  (snap1.policy as any).mode = "corrupted";

  assert.equal(store.getRecord().revision, 0);
  assert.equal(store.getRecord().policy.mode, "inherit");
});

test("SubagentPolicyStore: optimistic locking conflict when expectedRevision mismatches", async () => {
  const kv = createMockKv();
  const store = new SubagentPolicyStore(kv);
  await store.hydrate();

  await assert.rejects(
    () => store.setPolicy({ mode: "inherit" }, 99),
    (err: unknown) => {
      assert.ok(err instanceof SubagentRevisionConflictError);
      assert.equal(err.code, "REVISION_CONFLICT");
      return true;
    }
  );
  assert.equal(store.getRecord().revision, 0);
});

test("SubagentPolicyStore: concurrent updates with same expectedRevision yield exactly 1 success and 1 conflict", async () => {
  const kv = createMockKv();
  const store = new SubagentPolicyStore(kv);
  await store.hydrate();

  const policy1: SubagentPolicy = { mode: "inherit" };
  const policy2: SubagentPolicy = {
    mode: "configured",
    configuredProfile: {
      model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
      thinkingLevel: "medium",
    },
  };

  const results = await Promise.allSettled([
    store.setPolicy(policy1, 0),
    store.setPolicy(policy2, 0),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof SubagentRevisionConflictError);
  assert.equal(store.getRecord().revision, 1);
});

test("SubagentPolicyStore: failed persist keeps previous cache intact and queue stays resilient", async () => {
  const kv = createMockKv();
  const store = new SubagentPolicyStore(kv);
  await store.hydrate();

  kv.set = async () => {
    throw new Error("Disk I/O error");
  };

  await assert.rejects(() => store.setPolicy({ mode: "inherit" }, 0), new RegExp("Disk I/O error"));
  assert.equal(store.getRecord().revision, 0);

  // Restore kv.set and verify subsequent write still works (queue is resilient)
  kv.set = async (key: string, val: unknown) => {
    kv._raw.set(key, val);
  };
  const recovered = await store.setPolicy({ mode: "inherit" }, 0);
  assert.equal(recovered.revision, 1);
  assert.equal(store.getRecord().revision, 1);
});

test("SubagentPolicyStore: corrupt data on hydrate throws explicit SUBAGENT_POLICY_LOAD_ERROR", async () => {
  const kv = createMockKv({
    "subagent.policy.v1": { corrupted: true, version: 99 },
  });
  const store = new SubagentPolicyStore(kv);

  await assert.rejects(
    () => store.hydrate(),
    (err: unknown) => {
      assert.ok(err instanceof SubagentPolicyLoadError);
      assert.equal(err.code, "SUBAGENT_POLICY_LOAD_ERROR");
      return true;
    }
  );
});

test("SubagentPolicyStore: storage read error on hydrate throws explicit SUBAGENT_POLICY_LOAD_ERROR", async () => {
  const kv = createMockKv();
  kv.get = async () => {
    throw new Error("Connection failed");
  };
  const store = new SubagentPolicyStore(kv);

  await assert.rejects(
    () => store.hydrate(),
    (err: unknown) => {
      assert.ok(err instanceof SubagentPolicyLoadError);
      assert.equal(err.code, "SUBAGENT_POLICY_LOAD_ERROR");
      assert.ok(err.cause);
      return true;
    }
  );
});
