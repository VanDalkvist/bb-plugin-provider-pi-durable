import assert from "node:assert/strict";
import { it } from "node:test";
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { NativeServerAdmission } from "../src/native-server-admission.ts";
import { nativeChildHostContract, NATIVE_CHILD_CREDENTIAL_ENV, NATIVE_CHILD_ROUTE_ENV } from "../src/native-child-host-contract.ts";
import { nativeChildDiscoverySignals } from "../src/native-child-discovery-contract.ts";

function fixture() {
 const kv = new Map<string, unknown>();
 const calls: string[] = [];
 let identity = "native-session";
 let source: string | null = null;
 let metadata: unknown = null;
 let readyGeneration = 0;
 const thread = { id: "root", projectId: "project", parentThreadId: null, providerId: "pi-durable", environmentId: "env", deletedAt: null, originKind: null, sourceThreadId: source, environment: { id: "env", hostId: "host", projectId: "project", path: "/workspace", lifecycle: { phase: "active" } } };
 const bb = { pluginId: "plugin", storage: { kv: { get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => { calls.push(`kv:${key}`); kv.set(key, value); } } }, sdk: { threads: {
  get: async () => ({ ...thread, sourceThreadId: source }), getPluginMetadata: async () => ({ data: metadata }),
  events: { list: async () => [{ type: "thread/identity", data: { providerThreadId: identity } }] },
  defaultExecutionOptions: async () => ({ model: "provider/model", reasoningLevel: "high" }),
 } } } as unknown as Pick<BbPluginApi, "pluginId" | "sdk" | "storage">;
 const host = { call: async (method: string, input: any) => {
  calls.push(`host:${method}`);
  if (method === "resolveSessionLocation") return { durableSessionId: "sid", sessionDirectory: `/sessions/${input.providerThreadId}` };
  if (method === "prepareRoot") { assert.equal(input.route.providerThreadId, "native-session"); assert.equal(input.launch.model, undefined); assert.equal(input.launch.thinking, undefined); return { endpoint: "/memory", credential: "private", generation: 0, phase: "pending" }; }
  if (method === "rootReadiness") return { ready: readyGeneration > 0, generation: readyGeneration };
  if (method === "discoverNativeChildren") return [];
  if (method === "registerNativeChild") return { endpoint: "/memory", credential: "private", generation: 1 };
  throw Error(`unexpected ${method}`);
 } } as unknown as ExperimentalHostClient<typeof nativeChildHostContract, typeof nativeChildDiscoverySignals>;
 return { admission: new NativeServerAdmission(bb, host), kv, calls, setReady: (value: number) => { readyGeneration = value; }, changeIdentity: (value: string) => { identity = value; }, setMetadata: (value: unknown) => { metadata = value; }, setSource: (value: string | null) => { source = value; } };
}
const context = { threadId: "root", projectId: "project", hostId: "host" };
it("restores typed provider SID, immutable model/placement and private credentials, reconciles without execution", async () => {
 const f = fixture();
 const [one, two] = await Promise.all([f.admission.environment(context), f.admission.environment(context)]);
 assert.equal(f.calls.filter((v) => v === "host:resolveSessionLocation").length, 1);
 assert.equal(f.calls.filter((v) => v === "host:prepareRoot").length, 2);
 assert.equal(f.calls.filter((v) => v === "host:discoverNativeChildren").length, 0, "server must not await discovery before bridge configure");
 assert.equal(one.find((item) => item.name === NATIVE_CHILD_CREDENTIAL_ENV)?.value, "private");
 assert.deepEqual(one, two);
 assert.equal(JSON.parse(one.find((item) => item.name === NATIVE_CHILD_ROUTE_ENV)!.value as string).providerThreadId, "native-session");
 assert.equal(JSON.stringify([...f.kv]).includes("private"), false);
 f.changeIdentity("other-session");
 await assert.rejects(() => f.admission.environment(context), /identity changed/);
});
it("discovers only after a genuine root-ready signal with exact host and generation", async () => {
 const f = fixture();
 await f.admission.environment(context);
 assert.equal(f.calls.filter((call) => call === "host:discoverNativeChildren").length, 0);
 f.setReady(3);
 await assert.rejects(f.admission.rootReady({ parentThreadId: "root", durableSessionId: "sid", generation: 2 }, "host"), /generation changed/);
 await assert.rejects(f.admission.rootReady({ parentThreadId: "root", durableSessionId: "sid", generation: 3 }, "foreign"), /denied/);
 await f.admission.rootReady({ parentThreadId: "root", durableSessionId: "sid", generation: 3 }, "host");
 await f.admission.rootReady({ parentThreadId: "root", durableSessionId: "sid", generation: 3 }, "host");
 assert.equal(f.calls.filter((call) => call === "host:discoverNativeChildren").length, 1, "ready signal/retry reconciles once per generation");
});
it("refuses unbound metadata/forks and mismatched host even when environment resolver caller swallows error", async () => {
 const f = fixture();
 f.setMetadata({ nativeDurableLocator: "untrusted" });
 await assert.rejects(() => f.admission.environment(context), /binding missing/);
 f.setMetadata(null);
 f.setSource("fork-source");
 await assert.rejects(() => f.admission.environment(context), /fork\/restore/);
 f.setSource(null);
 await assert.rejects(() => f.admission.environment({ ...context, hostId: "foreign" }), /admission denied/);
 assert.equal(f.calls.some((call) => call === "host:prepareRoot"), false);
});
