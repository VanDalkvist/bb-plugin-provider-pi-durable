import assert from "node:assert/strict";
import { it } from "node:test";
import { NativeChildBbSync } from "../src/native-child-bb-sync.ts";
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { nativeChildHostContract } from "../src/native-child-host-contract.ts";
import { nativeChildDiscoverySignals } from "../src/native-child-discovery-contract.ts";

const signal = { parentThreadId: "root", durableSessionId: "sid", parentConversationId: ROOT_CONVERSATION_ID, childConversationId: 8, taskId: 7, requestId: "subagent:7", phase: "intent" as const };
function fake() {
 const kv = new Map<string, unknown>([["native-root:root", { route: { threadId: "root", placement: { hostId: "host", projectId: "project", environmentId: "env" } }, durableSessionId: "sid" }]]);
 const calls: string[] = [];
 const parent = { id: "root", deletedAt: null, providerId: "pi-durable", projectId: "project", environmentId: "env", parentThreadId: null, environment: { id: "env", hostId: "host", lifecycle: { phase: "active" } } };
 const child = { ...parent, environment: { ...parent.environment }, id: "bb-child", parentThreadId: "root", originPluginId: "plugin", visibility: "visible" };
 let slot: typeof child | undefined;
 const metadata = { data: { nativeDurableLocator: "sid:8:7" } };
 const bb = { pluginId: "plugin", storage: { kv: { get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => { calls.push(`kv:${key}`); kv.set(key, value); } } }, sdk: { threads: {
  events: { list: async () => [{ type: "thread/identity", data: { providerThreadId: "actual-child-sid" } }] },
  get: async ({ threadId }: { threadId: string }) => threadId === "root" ? parent : child,
  list: async () => slot ? [slot] : [],
  getPluginMetadata: async () => metadata,
  spawn: async (args: { input: unknown[]; environment: { type: string; environmentId: string }; parentThreadId: string; visibility: string }) => { assert.deepEqual(args.input, []); assert.equal(args.environment.environmentId, "env"); assert.equal(args.parentThreadId, "root"); assert.equal(args.visibility, "visible"); calls.push("spawn:empty"); slot = child; return child; },
 } } } as unknown as Pick<BbPluginApi, "pluginId" | "storage" | "sdk">;
 let allowSubmit = false;
 const host = { call: async (method: string, input: any) => {
  calls.push(`host:${method}`);
  if (method === "inspectNativeChildIntent") return { ...signal, valid: true };
  if (method === "registerNativeChild") { assert.equal(allowSubmit, true, "submitted native proof required"); assert.equal(input.route.child.requestId, signal.requestId); assert.equal(input.route.providerThreadId, "actual-child-sid"); return { endpoint: "/memory", credential: "private", generation: 1 }; }
  throw Error("Unexpected host RPC");
 } } as unknown as ExperimentalHostClient<typeof nativeChildHostContract, typeof nativeChildDiscoverySignals>;
 return { sync: new NativeChildBbSync(bb, host), calls, kv, child, submit: () => { allowSubmit = true; } };
}

it("creates exactly one empty-input visible BB slot at the installed Durable root intent; rejects zero root", async () => {
 assert.equal(ROOT_CONVERSATION_ID, 1, "fixture must exercise the installed Durable root, not a fabricated zero");
 const f = fake();
 await assert.rejects(() => f.sync.observe({ ...signal, parentConversationId: 0 }, "host"), /Native parent mismatch/);
 await Promise.all([f.sync.observe(signal, "host"), f.sync.observe(signal, "host")]);
 assert.equal(f.calls.filter((v) => v === "spawn:empty").length, 1);
 assert.equal(f.calls.includes("host:registerNativeChild"), false);
 assert.equal(f.kv.has("native-view:bb-child"), false);
 f.submit();
 await f.sync.observe({ ...signal, phase: "submitted" }, "host");
 await f.sync.observe({ ...signal, phase: "submitted" }, "host");
 assert.equal(f.calls.filter((v) => v === "host:registerNativeChild").length, 1);
 assert.equal(f.calls.filter((v) => v === "spawn:empty").length, 1);
 assert.ok(f.calls.indexOf("host:registerNativeChild") < f.calls.indexOf("kv:native-view:bb-child"));
 assert.ok(!JSON.stringify([...f.kv]).includes("private"));
});

it("reconciles crash after spawn and refuses changed placement / identity", async () => {
 const f = fake();
 await f.sync.observe(signal, "host");
 f.kv.delete("native-binding:root:sid:8:7");
 f.submit();
 const restarted = f.sync;
 await restarted.observe({ ...signal, phase: "submitted" }, "host");
 assert.equal(f.calls.filter((v) => v === "spawn:empty").length, 1);
 await assert.rejects(() => restarted.observe({ ...signal, childConversationId: 9 }, "host"));
 await assert.rejects(() => restarted.observe(signal, "other-host"));
 f.child.environment.hostId = "moved-host";
 await assert.rejects(() => restarted.observe(signal, "host"), /slot placement changed/);
});
