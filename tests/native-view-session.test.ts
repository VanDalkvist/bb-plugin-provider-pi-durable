import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RedemptionIdentitySchema } from "../src/native-child-contract.ts";
import { NATIVE_CHILD_CREDENTIAL_ENV, NATIVE_CHILD_SOCKET_ENV, NATIVE_CHILD_ROUTE_ENV } from "../src/native-child-host-contract.ts";
import { NativeViewSession, resolveNativeViewConnection } from "../src/host/native-view-session.ts";
import type { NativeChildTransportRequest, NativeChildViewClient } from "../src/host/native-child-transport.ts";

const root = RedemptionIdentitySchema.parse({ kind: "ordinary-root", threadId: "root", providerThreadId: "session", placement: { parentThreadId: null, projectId: "project", environmentId: "environment", hostId: "host", providerId: "pi-durable" } });
const child = RedemptionIdentitySchema.parse({ kind: "native-child", threadId: "child", providerThreadId: "native-child-7", placement: { ...root.placement, parentThreadId: "root" }, child: { durableSessionId: "session", taskId: 7, conversationId: 2, requestId: "subagent:7" }, bootstrapRequestId: "bootstrap-7" });
const environment = { [NATIVE_CHILD_SOCKET_ENV]: "/memory/host.sock", [NATIVE_CHILD_CREDENTIAL_ENV]: "fixture-private-grant" };

function fixture(route = root) {
	const commands: NativeChildTransportRequest["command"][] = [];
	let attachments = 0;
	let releases = 0;
	let emit: ((event: unknown) => void) | undefined;
	let disconnect: ((reason: "closed" | "error") => void) | undefined;
	const events: unknown[] = [];
	const client: NativeChildViewClient = {
		request: async (command) => { commands.push(command); return command.type === "root-configure" ? { accepted: true, generation: 1 } : { accepted: true }; },
		attachRootView: async (listener, onDisconnect) => { attachments++; emit = listener; disconnect = onDisconnect; return () => { releases++; }; },
	};
	const session = new NativeViewSession({ connection: { endpoint: "/memory/host.sock", credential: "fixture-private-grant", expected: route }, session: { threadId: route.threadId, providerThreadId: route.providerThreadId },
		...(route.kind === "ordinary-root" ? { rootLaunch: { cwd: "/memory/project", model: { provider: "provider", modelId: "model" }, thinking: "low", environment: {} } } : {}),
		onEvent: (event) => events.push(event), createClient: () => client });
	return { session, commands, events, emit: (event: unknown) => emit?.(event), disconnect: () => disconnect?.("closed"), attachments: () => attachments, releases: () => releases };
}

describe("native Durable bridge view consumer", () => {
	it("requires the exact route and complete private credentials without legacy fallback", () => {
		assert.equal(resolveNativeViewConnection({ threadId: "root", providerThreadId: "session", providerOptions: {}, environment: {} }), undefined);
		assert.deepEqual(resolveNativeViewConnection({ threadId: "root", providerThreadId: "session", providerOptions: { nativeDurableRoute: root }, environment }), { endpoint: "/memory/host.sock", credential: "fixture-private-grant", expected: root });
		for (const candidate of [
			{ threadId: "foreign", providerThreadId: "session", providerOptions: { nativeDurableRoute: root }, environment },
			{ threadId: "root", providerThreadId: "foreign", providerOptions: { nativeDurableRoute: root }, environment },
			{ threadId: "root", providerThreadId: "session", providerOptions: {}, environment },
			{ threadId: "root", providerThreadId: "session", providerOptions: { nativeDurableRoute: root }, environment: {} },
			{ threadId: "root", providerThreadId: "session", providerOptions: { nativeDurableRoute: root }, environment: { [NATIVE_CHILD_SOCKET_ENV]: "/memory/host.sock" } },
		]) assert.throws(() => resolveNativeViewConnection(candidate));
	});

	it("takes the canonical provider identity from trusted private admission and rejects incomplete required admission", () => {
		const admitted = { ...environment, [NATIVE_CHILD_ROUTE_ENV]: JSON.stringify(child) };
		const connection = resolveNativeViewConnection({ threadId: "child", providerOptions: { nativeDurableRequired: true }, environment: admitted });
		assert.deepEqual(connection?.expected, child);
		assert.throws(() => resolveNativeViewConnection({ threadId: "child", providerOptions: { nativeDurableRequired: true }, environment: {} }));
		assert.throws(() => resolveNativeViewConnection({ threadId: "child", providerOptions: { nativeDurableRoute: root }, environment: admitted }));
		assert.throws(() => resolveNativeViewConnection({ threadId: "child", providerOptions: {}, environment: { ...environment, [NATIVE_CHILD_ROUTE_ENV]: "broken-json" } }));
	});

	it("opening and closing a child attaches a view without submitting, resuming or cancelling", { timeout: 1000 }, async () => {
		const f = fixture(child);
		await Promise.all([f.session.start(), f.session.start()]);
		assert.equal(f.attachments(), 1);
		assert.deepEqual(f.commands, []);
		f.emit({ type: "message_start", message: { role: "assistant" } });
		assert.deepEqual(f.events, [{ type: "message_start", message: { role: "assistant" } }]);
		await f.session.closeGracefully();
		await f.session.closeGracefully();
		assert.equal(f.releases(), 1);
		assert.deepEqual(f.commands, []);
		f.emit({ type: "agent_end" });
		assert.equal(f.events.length, 1);
		await assert.rejects(f.session.start(), /closed/);
	});

	it("remote view loss invalidates session without abort or other native work", { timeout: 1000 }, async () => {
		const f = fixture(child);
		await f.session.start();
		f.disconnect();
		assert.equal(f.session.exited, true);
		await assert.rejects(f.session.start(), /closed/);
		await assert.rejects(f.session.prompt('{"type":"native-child-bootstrap","requestId":"bootstrap-7"}'), /closed/);
		await f.session.closeGracefully();
		assert.deepEqual(f.commands, []);
	});

	it("child bootstrap acknowledges only the exact registered control and rejects follow-ups", { timeout: 1000 }, async () => {
		const f = fixture(child);
		await f.session.start();
		for (const text of ["run this", '{"type":"native-child-bootstrap","requestId":"other"}', '{"type":"native-child-bootstrap","requestId":"bootstrap-7","message":"run"}']) await assert.rejects(f.session.prompt(text), /follow-up denied/);
		await assert.rejects(f.session.steer("run this"), /follow-up denied/);
		await assert.rejects(f.session.compact(), /read-only/);
		assert.deepEqual(f.commands, []);
		await f.session.prompt('{"type":"native-child-bootstrap","requestId":"bootstrap-7"}');
		assert.deepEqual(f.commands, [{ type: "bootstrap-ack", requestId: "bootstrap-7" }]);
	});

	it("explicit child stop sends no parent abort or client-supplied target", { timeout: 1000 }, async () => {
		const f = fixture(child);
		await f.session.start();
		await f.session.abort();
		assert.deepEqual(f.commands, [{ type: "child-stop" }]);
		assert.equal(f.releases(), 0);
		assert.equal(f.session.exited, false);
	});

	it("root attests launch context before attachment and fails closed without acknowledgement", { timeout: 1000 }, async () => {
		const calls: string[] = [];
		const session = new NativeViewSession({ connection: { endpoint: "/memory/host.sock", credential: "private", expected: root },
			session: { threadId: "root", providerThreadId: "session" }, rootLaunch: { cwd: "/memory/project", model: { provider: "provider", modelId: "first-turn" }, thinking: "high", environment: { CUSTOM: "value" } }, onEvent: () => undefined,
			createClient: () => ({ request: async (command) => { calls.push(command.type); return { accepted: false, generation: 0 }; }, attachRootView: async () => { calls.push("attach"); return () => undefined; } }) });
		await assert.rejects(session.start());
		assert.deepEqual(calls, ["root-configure"]);
		await session.closeGracefully();
	});

	it("close during deferred root configuration never attaches or submits a prompt", { timeout: 1000 }, async () => {
		let resolveConfigure!: (value: unknown) => void;
		let attachments = 0;
		const commands: unknown[] = [];
		const session = new NativeViewSession({ connection: { endpoint: "/memory/host.sock", credential: "private", expected: root },
			session: { threadId: "root", providerThreadId: "session" }, rootLaunch: { cwd: "/memory/project", model: { provider: "provider", modelId: "model" }, thinking: "low", environment: {} }, onEvent: () => undefined,
			createClient: () => ({ request: (command) => { commands.push(command); return new Promise((resolve) => { resolveConfigure = resolve; }); },
				attachRootView: async () => { attachments++; return () => undefined; } }),
		});
		const starting = session.start();
		await session.closeGracefully();
		resolveConfigure({ accepted: true, generation: 1 });
		await assert.rejects(starting, /closed/);
		assert.equal(attachments, 0);
		assert.deepEqual(commands.map((command) => (command as { type: string }).type), ["root-configure"]);
	});

	it("root stats project context usage from retained runner", { timeout: 1000 }, async () => {
		const deltas: unknown[] = [];
		const session = new NativeViewSession({ connection: { endpoint: "/memory/host.sock", credential: "private", expected: root },
			session: { threadId: "root", providerThreadId: "session" }, rootLaunch: { cwd: "/memory/project", model: { provider: "provider", modelId: "model" }, thinking: "low", environment: {} }, onEvent: () => undefined,
			onContextUsage: (delta) => deltas.push(delta),
			createClient: () => ({ request: async (command) => command.type === "root-configure" ? { accepted: true, generation: 1 } : { contextUsage: { tokens: 42, contextWindow: 100 } }, attachRootView: async () => () => undefined }) });
		await session.start();
		await session.refreshContextUsage();
		assert.deepEqual(deltas, [{ kind: "contextWindow", used: 42, size: 100, estimated: true, attach: "currentOrLast" }]);
		await session.closeGracefully();
	});

	it("root prompts and controls use the retained host instead of a per-thread executor", { timeout: 1000 }, async () => {
		const f = fixture();
		await f.session.start();
		await f.session.prompt("hello");
		await f.session.steer("adjust");
		await f.session.abort();
		await f.session.compact("keep decisions");
		assert.deepEqual(f.commands, [{ type: "root-configure", launch: { cwd: "/memory/project", model: { provider: "provider", modelId: "model" }, thinking: "low", environment: {} } }, { type: "root", command: { type: "prompt", message: "hello" } }, { type: "root", command: { type: "steer", message: "adjust" } }, { type: "root", command: { type: "abort" } }, { type: "root", command: { type: "compact", instructions: "keep decisions" } }]);
	});
});
