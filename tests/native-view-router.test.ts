import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderBridge } from "../src/host/bridge.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { NativeViewSession } from "../src/host/native-view-session.ts";
import { NATIVE_CHILD_CREDENTIAL_ENV, NATIVE_CHILD_ROUTE_ENV, NATIVE_CHILD_SOCKET_ENV } from "../src/native-child-host-contract.ts";
import { RedemptionIdentitySchema } from "../src/native-child-contract.ts";
import type { NativeChildViewClient } from "../src/host/native-child-transport.ts";

const placement = { parentThreadId: "parent", projectId: "project", environmentId: "environment", hostId: "host", providerId: "pi-durable" };
const child = RedemptionIdentitySchema.parse({ kind: "native-child", threadId: "child", providerThreadId: "native-7", placement, child: { durableSessionId: "root-session", taskId: 7, conversationId: 8, requestId: "subagent:7" }, bootstrapRequestId: "bootstrap-7" });
const root = RedemptionIdentitySchema.parse({ kind: "ordinary-root", threadId: "root", providerThreadId: "root-session", placement: { ...placement, parentThreadId: null } });
const env = (route: typeof child | typeof root) => ({ [NATIVE_CHILD_CREDENTIAL_ENV]: "private-grant", [NATIVE_CHILD_SOCKET_ENV]: "/memory/socket", [NATIVE_CHILD_ROUTE_ENV]: JSON.stringify(route) });

function fixture() {
	const frames: any[] = [];
	const commands: Array<{ threadId: string; command: unknown }> = [];
	const releases: string[] = [];
	const disconnects = new Map<string, (reason: "closed" | "error") => void>();
	const bridge = new ProviderBridge((line) => frames.push(JSON.parse(line)), {
		createRegistry: (notify) => new SessionRegistry(notify, { createNativeSession: (options) => {
			const client: NativeChildViewClient = {
				request: async (command) => { commands.push({ threadId: options.session.threadId, command }); return command.type === "root-configure" ? { accepted: true, generation: 1 } : { accepted: true }; },
				attachRootView: async (_listener, onDisconnect) => { if (onDisconnect) disconnects.set(options.session.threadId, onDisconnect); return () => { releases.push(options.session.threadId); disconnects.delete(options.session.threadId); }; },
			};
			return new NativeViewSession({ ...options, createClient: () => client });
		} }),
	});
	let id = 0;
	const call = async (method: string, params: Record<string, unknown>) => {
		const requestId = ++id;
		await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
		return frames.find((frame) => frame.id === requestId);
	};
	const options = (route: typeof child | typeof root) => ({ threadId: route.threadId, cwd: "/memory/project", ...(route.kind === "ordinary-root" ? { model: "provider/default", thinkingLevel: "low" } : {}), options: { providerOptions: { nativeDurableRequired: true } }, shellEnvOverrides: env(route) });
	return { bridge, call, frames, commands, releases, options, disconnect: (threadId: string) => disconnects.get(threadId)?.("closed") };
}

test("actual bridge start/turn/bootstrap/reopen/shutdown never executes child or resets replay", async () => {
	const f = fixture();
	const p = f.options(child);
	assert.equal((await f.call("thread/start", p)).result.providerThreadId, "native-7");
	assert.equal(f.frames.some((frame) => JSON.stringify(frame).includes("session.reset")), false);
	assert.deepEqual(f.commands, []);
	const bootstrap = { ...p, input: [{ type: "text", text: JSON.stringify({ type: "native-child-bootstrap", requestId: "bootstrap-7" }) }] };
	assert.ok((await f.call("turn/start", bootstrap)).result);
	assert.deepEqual(f.commands, [{ threadId: "child", command: { type: "bootstrap-ack", requestId: "bootstrap-7" } }]);
	assert.ok((await f.call("turn/start", { ...p, input: [{ type: "text", text: "do extra work" }] })).error);
	assert.equal(f.commands.length, 1);
	assert.ok((await f.call("thread/discard", { threadId: "child" })).result);
	assert.deepEqual(f.releases, ["child"]);
	assert.ok((await f.call("thread/resume", p)).result);
	await f.bridge.shutdown();
	assert.deepEqual(f.releases, ["child", "child"]);
	assert.equal(f.commands.length, 1);
});

test("actual bridge rejects cached credential drift, missing admission, changed cwd, fake fork; scoped stop targets only child", async () => {
	const f = fixture();
	const p = f.options(child);
	await f.call("thread/start", p);
	for (const changed of [
		{ ...p, shellEnvOverrides: { ...p.shellEnvOverrides, [NATIVE_CHILD_CREDENTIAL_ENV]: "different" } },
		{ ...p, shellEnvOverrides: {} },
		{ ...p, cwd: "/memory/other" },
	]) assert.ok((await f.call("turn/start", { ...changed, input: [{ type: "text", text: "hello" }] })).error);
	assert.ok((await f.call("thread/fork", p)).error);
	assert.deepEqual(f.commands, []);
	assert.ok((await f.call("thread/stop", { threadId: "child" })).result);
	assert.deepEqual(f.commands, [{ threadId: "child", command: { type: "child-stop" } }]);
	assert.deepEqual(f.releases, ["child"]);
	await f.bridge.shutdown();
});

test("root configure uses trusted bridge context once, strips private grant env, denies cached env/prompt drift", async () => {
	const f = fixture();
	const p = f.options(root);
	const first = { ...p, appendSystemPrompt: "trusted inline instructions", shellEnvOverrides: { ...p.shellEnvOverrides, CUSTOM: "trusted", BB_PI_DURABLE_PARENT_THREAD_ID: "untrusted-override" } };
	assert.ok((await f.call("thread/start", first)).result);
	assert.deepEqual(f.commands, [{ threadId: "root", command: { type: "root-configure", launch: {
		cwd: "/memory/project", model: { provider: "provider", modelId: "default" }, thinking: "low", appendSystemPrompt: "trusted inline instructions", environment: { CUSTOM: "trusted" },
	} } }]);
	assert.ok((await f.call("thread/resume", first)).result);
	assert.equal(f.commands.length, 1);
	for (const changed of [{ ...first, appendSystemPrompt: "different" }, { ...first, shellEnvOverrides: { ...first.shellEnvOverrides, CUSTOM: "different" } }]) {
		assert.ok((await f.call("thread/resume", changed)).error);
	}
	assert.equal(f.commands.length, 1);
	await f.bridge.shutdown();
});

test("pre-ready root configure failure leaves no cached view and does not attach or prompt", async () => {
	const frames: any[] = [];
	let attaches = 0;
	let attempts = 0;
	const bridge = new ProviderBridge((line) => frames.push(JSON.parse(line)), {
		createRegistry: (notify) => new SessionRegistry(notify, { createNativeSession: (options) => new NativeViewSession({ ...options,
			createClient: () => ({ request: async (command) => { attempts++; if (command.type === "root-configure") {
					if (attempts < 3) throw new Error("configuration denied");
					return { accepted: true, generation: 1 };
				} throw new Error("unexpected native command"); },
				attachRootView: async () => { attaches++; return () => undefined; } }),
		}) }),
	});
	const params = { threadId: "root", cwd: "/memory/project", model: "provider/model", thinkingLevel: "low", options: { providerOptions: { nativeDurableRequired: true } }, shellEnvOverrides: env(root) };
	for (const id of [1, 2]) await bridge.handleLine(JSON.stringify({ id, method: "thread/start", params }));
	assert.deepEqual(frames.filter((frame) => frame.error).length, 2);
	assert.equal(attempts, 2);
	assert.equal(attaches, 0);
	await bridge.handleLine(JSON.stringify({ id: 3, method: "thread/start", params }));
	assert.ok(frames.find((frame) => frame.id === 3)?.result);
	assert.equal(attaches, 1);
	assert.equal(attempts, 3);
	await bridge.shutdown();
});

test("first trusted root model B overrides staged server default A before first prompt", async () => {
	const f = fixture();
	const p = { ...f.options(root), model: "provider/first-turn-B", thinkingLevel: "max" };
	assert.ok((await f.call("thread/start", p)).result);
	assert.ok((await f.call("turn/start", { ...p, input: [{ type: "text", text: "first prompt" }] })).result);
	assert.deepEqual(f.commands, [
		{ threadId: "root", command: { type: "root-configure", launch: { cwd: "/memory/project", model: { provider: "provider", modelId: "first-turn-B" }, thinking: "max", environment: {} } } },
		{ threadId: "root", command: { type: "root", command: { type: "prompt", message: "first prompt" } } },
	]);
	await f.bridge.shutdown();
});

test("root model/thinking changes route to retained root, child execution settings cannot change", async () => {
	const f = fixture();
	const p = f.options(root);
	await f.call("thread/start", { ...p, model: "provider/old", thinkingLevel: "low" });
	assert.ok((await f.call("turn/start", { ...p, model: "provider/new", thinkingLevel: "high", input: [{ type: "text", text: "hello" }] })).result);
	assert.deepEqual(f.commands, [
		{ threadId: "root", command: { type: "root-configure", launch: { cwd: "/memory/project", model: { provider: "provider", modelId: "old" }, thinking: "low", environment: {} } } },
		{ threadId: "root", command: { type: "root", command: { type: "set_model", provider: "provider", modelId: "new" } } },
		{ threadId: "root", command: { type: "root", command: { type: "set_thinking_level", level: "high" } } },
		{ threadId: "root", command: { type: "root", command: { type: "prompt", message: "hello" } } },
	]);
	const childParams = f.options(child);
	await f.call("thread/start", childParams);
	assert.ok((await f.call("turn/start", { ...childParams, model: "provider/new", input: [{ type: "text", text: "hello" }] })).error);
	assert.equal(f.commands.length, 4);
	await f.bridge.shutdown();
});

test("production bridge reopens an authorized root view after remote disconnect without replaying work", async () => {
	const f = fixture();
	const p = f.options(root);
	assert.ok((await f.call("thread/start", p)).result);
	f.disconnect("root");
	const replacement = { ...p, shellEnvOverrides: { ...p.shellEnvOverrides, [NATIVE_CHILD_CREDENTIAL_ENV]: "renewed-private-grant" } };
	assert.ok((await f.call("thread/resume", replacement)).result);
	assert.deepEqual(f.commands.map(({ command }) => (command as { type: string }).type), ["root-configure", "root-configure"]);
	await f.bridge.shutdown();
});

test("root controls stay root-scoped and shutdown detaches only", async () => {
	const f = fixture();
	const p = f.options(root);
	await f.call("thread/start", p);
	assert.ok((await f.call("turn/start", { ...p, input: [{ type: "text", text: "hello" }] })).result);
	assert.ok((await f.call("thread/stop", { threadId: "root", intent: "interrupt" })).result);
	assert.ok((await f.call("thread/discard", { threadId: "root" })).result);
	assert.deepEqual(f.commands, [
		{ threadId: "root", command: { type: "root-configure", launch: { cwd: "/memory/project", model: { provider: "provider", modelId: "default" }, thinking: "low", environment: {} } } },
		{ threadId: "root", command: { type: "root", command: { type: "prompt", message: "hello" } } },
		{ threadId: "root", command: { type: "root", command: { type: "abort" } } },
	]);
	assert.deepEqual(f.releases, ["root"]);
	await f.bridge.shutdown();
});
