import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { NativeViewSession } from "../src/host/native-view-session.ts";
import { NATIVE_CHILD_CREDENTIAL_ENV, NATIVE_CHILD_ROUTE_ENV, NATIVE_CHILD_SOCKET_ENV } from "../src/native-child-host-contract.ts";
import { RedemptionIdentitySchema } from "../src/native-child-contract.ts";
import type { NativeChildViewClient } from "../src/host/native-child-transport.ts";

const route = RedemptionIdentitySchema.parse({ kind: "native-child", threadId: "child", providerThreadId: "child-session", placement: { parentThreadId: "parent", projectId: "project", environmentId: "environment", hostId: "host", providerId: "pi-durable" }, child: { durableSessionId: "root-session", taskId: 7, conversationId: 8, requestId: "subagent:7" }, bootstrapRequestId: "bootstrap-7" });
const admission = { cwd: "/memory/project", options: { providerOptions: { nativeDurableRequired: true } }, shellEnvOverrides: { [NATIVE_CHILD_ROUTE_ENV]: JSON.stringify(route), [NATIVE_CHILD_SOCKET_ENV]: "/memory/socket", [NATIVE_CHILD_CREDENTIAL_ENV]: "credential" } };

function fixture() {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const commands: unknown[] = [];
	let attachments = 0;
	let releases = 0;
	let resolveAttach!: (detach: () => void) => void;
	let rejectAttach!: (error: Error) => void;
	let emit: ((value: unknown) => void) | undefined;
	let disconnect: ((reason: "closed" | "error") => void) | undefined;
	let hold = false;
	const client: NativeChildViewClient = {
		request: async (command) => { commands.push(command); return { accepted: true }; },
		attachRootView: async (listener, onDisconnect) => {
			attachments++;
			emit = listener;
			disconnect = onDisconnect;
			if (hold) return new Promise((resolve, reject) => { resolveAttach = resolve; rejectAttach = reject; });
			return () => { releases++; };
		},
	};
	const registry = new SessionRegistry((method, params) => notifications.push({ method, params }), {
		createNativeSession: (options) => new NativeViewSession({ ...options, createClient: () => client }),
	});
	return { registry, notifications, commands, attachments: () => attachments, releases: () => releases,
		emit: (value: unknown) => emit?.(value), disconnect: () => disconnect?.("closed"), hold: () => { hold = true; }, finish: () => resolveAttach(() => { releases++; }), fail: () => { hold = false; rejectAttach(new Error("attach denied")); } };
}

test("actual registry admits one view, rejects credential/route/provider identity/cwd drift and detaches on shutdown", async () => {
	const f = fixture();
	const get = () => f.registry.createOrGet("child", "child-session", admission);
	const [first, second] = await Promise.all([get(), get()]);
	assert.equal(first, second);
	assert.equal(f.attachments(), 1);
	assert.equal(await f.registry.createOrGet("child", "child-session", { ...admission, cwd: undefined }), first);
	assert.equal(f.notifications.filter((n) => n.method === "thread/identity").length, 1);
	assert.equal(f.notifications.filter((n) => JSON.stringify(n.params).includes("session.reset")).length, 0);
	for (const changed of [
		{ ...admission, cwd: "/memory/other" },
		{ ...admission, shellEnvOverrides: { ...admission.shellEnvOverrides, [NATIVE_CHILD_CREDENTIAL_ENV]: "other" } },
		{ ...admission, shellEnvOverrides: { ...admission.shellEnvOverrides, [NATIVE_CHILD_ROUTE_ENV]: JSON.stringify({ ...route, bootstrapRequestId: "other" }) } },
		{ ...admission, shellEnvOverrides: {} },
	]) await assert.rejects(f.registry.createOrGet("child", "child-session", changed), /denied|admission changed|Invalid input/);
	await assert.rejects(f.registry.createOrGet("child", "wrong", admission), /denied/);
	await assert.rejects(f.registry.createOrGet("child", "child-session", { ...admission, appendSystemPrompt: "cannot reconfigure child" }), /execution settings are immutable/);
	await assert.rejects(f.registry.reconcileCwd("child", "/memory/other"), /re-admission/);
	f.emit({ type: "agent_end" });
	await f.registry.stopAll();
	assert.equal(f.releases(), 1);
	assert.deepEqual(f.commands, []);
});

test("unexpected disconnect invalidates cached session; authorized new credential reattaches without native commands", async () => {
	const f = fixture();
	const stale = await f.registry.createOrGet("child", "child-session", admission);
	f.disconnect();
	assert.equal(stale.exited, true);
	assert.equal(f.registry.get("child"), undefined);
	const freshAdmission = { ...admission, shellEnvOverrides: { ...admission.shellEnvOverrides, [NATIVE_CHILD_CREDENTIAL_ENV]: "new-scoped-grant" } };
	const fresh = await f.registry.createOrGet("child", "child-session", freshAdmission);
	assert.notEqual(fresh, stale);
	assert.equal(f.attachments(), 2);
	assert.deepEqual(f.commands, []);
	await f.registry.stopAll();
});

test("concurrent creation and stop during attach release late lease and cannot poison the cache", async () => {
	const f = fixture();
	f.hold();
	const first = f.registry.createOrGet("child", "child-session", admission);
	const second = f.registry.createOrGet("child", "child-session", admission);
	await f.registry.stop("child");
	f.finish();
	await assert.rejects(first, /closed/);
	await assert.rejects(second, /closed/);
	assert.equal(f.attachments(), 1);
	assert.equal(f.releases(), 1);
	assert.equal(f.registry.get("child"), undefined);
	assert.deepEqual(f.commands, []);
	assert.equal(f.notifications.length, 0);
});

test("denied stale grant invalidates cached view and permits fresh authorized reattachment", async () => {
	let attempts = 0;
	let attachments = 0;
	const registry = new SessionRegistry(() => undefined, { createNativeSession: (options) => new NativeViewSession({ ...options, createClient: () => ({
		request: async () => { attempts++; throw new Error("grant denied"); },
		attachRootView: async () => { attachments++; return () => undefined; },
	}) }) });
	const stale = await registry.createOrGet("child", "child-session", admission);
	await assert.rejects(stale.abort(), /grant denied/);
	assert.equal(stale.exited, true);
	assert.equal(registry.get("child"), undefined);
	await registry.createOrGet("child", "child-session", { ...admission, shellEnvOverrides: { ...admission.shellEnvOverrides, [NATIVE_CHILD_CREDENTIAL_ENV]: "renewed-private-grant" } });
	assert.equal(attempts, 1);
	assert.equal(attachments, 2);
	await registry.stopAll();
});

test("detach failure does not poison the registry or abort native work", async () => {
	const requests: unknown[] = [];
	let attempts = 0;
	const registry = new SessionRegistry(() => undefined, { createNativeSession: (options) => new NativeViewSession({ ...options, createClient: () => ({
		request: async (command) => { requests.push(command); return { accepted: true }; },
		attachRootView: async () => { attempts++; return () => { if (attempts === 1) throw new Error("detach failed"); }; },
	}) }) });
	await registry.createOrGet("child", "child-session", admission);
	await assert.rejects(registry.stop("child"), /detach failed/);
	assert.equal(registry.get("child"), undefined);
	await registry.createOrGet("child", "child-session", admission);
	assert.equal(attempts, 2);
	assert.deepEqual(requests, []);
	await registry.stopAll();
});

test("failed attachment clears pending registry entry and retry gets a fresh lease", async () => {
	const f = fixture();
	f.hold();
	const first = f.registry.createOrGet("child", "child-session", admission);
	f.fail();
	await assert.rejects(first, /attach denied/);
	assert.equal(f.registry.get("child"), undefined);
	await f.registry.createOrGet("child", "child-session", admission);
	assert.equal(f.attachments(), 2);
	await f.registry.stopAll();
	assert.equal(f.releases(), 1);
});
