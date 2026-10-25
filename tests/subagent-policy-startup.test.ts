import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../server.ts";
import { SubagentPolicyLoadError } from "../src/policy/errors.ts";
import type { SubagentPolicyRecord } from "../src/policy/types.ts";

function createMockHost(kvInitial?: Record<string, unknown>) {
  const map = new Map<string, unknown>(Object.entries(kvInitial ?? {}));
  let registeredSettings: unknown = null;
  let registeredRpc: { contract: unknown; handlers: Record<string, (...args: any[]) => any> } | null = null;
  let registeredProvider: any = null;

  const kv = {
    async get<T>(key: string): Promise<T | undefined> {
      return structuredClone(map.get(key)) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      map.set(key, structuredClone(value));
    },
  };

  const host = {
    storage: { kv },
    settings: {
      define(s: unknown) {
        registeredSettings = s;
      },
    },
    rpc: {
      register(contract: unknown, handlers: Record<string, (...args: any[]) => any>) {
        registeredRpc = { contract, handlers };
      },
    },
    providers: {
      register(p: any) {
        registeredProvider = p;
      },
    },
    get registeredSettings() {
      return registeredSettings;
    },
    get registeredRpc() {
      return registeredRpc;
    },
    get registeredProvider() {
      return registeredProvider;
    },
    _rawKv: map,
  };

  return host;
}

test("server startup: holding KV read promise ensures provider and RPC are not registered prematurely", async () => {
  let resolveKv: (val: any) => void = () => {};
  const pendingPromise = new Promise((resolve) => {
    resolveKv = resolve;
  });

  let registered = false;
  const host = {
    storage: {
      kv: {
        get: () => pendingPromise,
        set: async () => {},
      },
    },
    settings: { define() {} },
    rpc: { register() { registered = true; } },
    providers: { register() { registered = true; } },
  };

  const pluginPromise = plugin(host as any);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(registered, false, "Provider and RPC must not be registered while KV hydration is pending");

  resolveKv(undefined);
  await pluginPromise;
  assert.equal(registered, true, "Provider and RPC registered after KV hydration completes");
});

test("server startup: corrupt KV storage rejects and registers nothing", async () => {
  let registered = false;
  const host = {
    storage: {
      kv: {
        get: async () => ({ corrupted: true, version: 99 }),
        set: async () => {},
      },
    },
    settings: { define() {} },
    rpc: { register() { registered = true; } },
    providers: { register() { registered = true; } },
  };

  await assert.rejects(
    () => plugin(host as any),
    (err: unknown) => {
      assert.ok(err instanceof SubagentPolicyLoadError);
      assert.equal(err.code, "SUBAGENT_POLICY_LOAD_ERROR");
      return true;
    }
  );
  assert.equal(registered, false, "Nothing registered on corrupt KV");
});

test("server startup: successful initialization wires deriveProviderOptions and subagent RPCs", async () => {
  const host = createMockHost();
  await plugin(host as any);

  assert.ok(host.registeredProvider);
  assert.ok(host.registeredRpc?.handlers.subagent_policy_get);
  assert.ok(host.registeredRpc?.handlers.subagent_policy_set);

  // Initial derived provider options has default inherit policy
  const initialOptions = host.registeredProvider.deriveProviderOptions({
    settings: { hideThinking: false },
  });
  assert.deepEqual(initialOptions, {
    hideThinking: false,
    subagentPolicy: {
      version: 1,
      revision: 0,
      policy: { mode: "inherit" },
    },
  });

  // Call subagent_policy_get
  const getResult = await host.registeredRpc.handlers.subagent_policy_get();
  assert.deepEqual(getResult, {
    record: {
      version: 1,
      revision: 0,
      policy: { mode: "inherit" },
    },
  });

  // Call subagent_policy_set
  const setResult = await host.registeredRpc.handlers.subagent_policy_set({
    policy: {
      mode: "configured",
      configuredProfile: {
        model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
        thinkingLevel: "high",
      },
    },
    expectedRevision: 0,
  });

  assert.equal(setResult.record.revision, 1);
  assert.equal(setResult.record.policy.mode, "configured");

  // Next deriveProviderOptions call delivers updated policy snapshot
  const updatedOptions = host.registeredProvider.deriveProviderOptions({
    settings: { hideThinking: true },
  });
  assert.equal(updatedOptions.hideThinking, true);
  assert.deepEqual(updatedOptions.subagentPolicy, setResult.record);

  // Calling with outdated revision rejects with conflict
  await assert.rejects(
    () =>
      host.registeredRpc!.handlers.subagent_policy_set({
        policy: { mode: "inherit" },
        expectedRevision: 0,
      }),
    (err: any) => {
      assert.equal(err.code, "conflict");
      return true;
    }
  );
});
