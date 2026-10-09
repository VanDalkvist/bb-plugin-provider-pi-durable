import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { NativeChildFrameDecoder, NativeChildTransportClient, NativeChildTransportServerAdapter, MAX_NATIVE_CHILD_FRAME_BYTES } from "../src/host/native-child-transport.ts";
import type { NativeChildTransportClientConnection, NativeChildTransportConnection, NativeChildTransportServer } from "../src/host/native-child-transport.ts";

class MemoryConnection extends EventEmitter implements NativeChildTransportConnection {
	readonly writes: string[] = [];
	other?: MemoryConnection;
	ended = false;
	destroyed = false;
	write(value: string): boolean { this.writes.push(value); return true; }
	end(): void { this.ended = true; }
	destroy(): void { this.destroyed = true; this.emit("close"); this.other?.emit("close"); }
	push(value: string): void { this.emit("data", Buffer.from(value)); }
}

class MemoryClientConnection extends MemoryConnection implements NativeChildTransportClientConnection {
	private readonly peer: MemoryConnection;
	constructor(peer: MemoryConnection) { super(); this.peer = peer; peer.other = this; }
	write(value: string): boolean { this.peer.push(value); return true; }
	end(): void { super.end(); this.emit("end"); this.peer.emit("end"); }
}

class MemoryServer extends EventEmitter implements NativeChildTransportServer {
	listening = false;
	listen(_endpoint: string, callback?: () => void): this { this.listening = true; callback?.(); return this; }
	close(callback?: (error?: Error) => void): this { this.listening = false; callback?.(); return this; }
}

const expected = { kind: "native-child" as const, threadId: "child-thread", providerThreadId: "provider-child", placement: {
	parentThreadId: "root-thread", projectId: "project", environmentId: "environment", hostId: "host", providerId: "pi-durable" as const,
}, child: { durableSessionId: "session", taskId: 8 as TaskId, conversationId: 9 as ConversationId, requestId: "subagent:8" }, bootstrapRequestId: "bootstrap:8" };

function frame(id: string, command: unknown, credential = "opaque-token") {
	return JSON.stringify({ id, credential, expected, command }) + "\n";
}

const bounded = (name: string, fn: () => void | Promise<void>) => it(name, { timeout: 2000 }, fn);

describe("native child private transport", () => {
	bounded("coalesces startup through permissions and leaves permission failures failed", async () => {
		const server = new MemoryServer();
		let resolvePermissions!: () => void;
		let markPermissionsStarted!: () => void;
		const permissionsStarted = new Promise<void>((resolve) => { markPermissionsStarted = resolve; });
		const permissions = new Promise<void>((resolve) => { resolvePermissions = resolve; });
		let permissionCalls = 0;
		const adapter = new NativeChildTransportServerAdapter({
			endpoint: "/injected/coalesced.sock",
			handle: async () => undefined,
			createServer: () => server,
			setPermissions: async () => { permissionCalls++; markPermissionsStarted(); await permissions; },
		});
		const first = adapter.start();
		const second = adapter.start();
		await permissionsStarted;
		let ready = false;
		void first.then(() => { ready = true; });
		await Promise.resolve();
		assert.equal(ready, false, "listen alone must not signal readiness before permissions");
		assert.equal(permissionCalls, 1, "concurrent startup shares the permission operation");
		resolvePermissions();
		await Promise.all([first, second]);
		await adapter.close();

		const failed = new NativeChildTransportServerAdapter({
			endpoint: "/injected/permission-denied.sock",
			handle: async () => undefined,
			createServer: () => new MemoryServer(),
			setPermissions: async () => { throw new Error("permission denied"); },
		});
		await assert.rejects(failed.start(), /permission denied/);
		await assert.rejects(failed.start(), /permission denied/);
		await failed.close();
	});

	bounded("closes owned idle peers on disposal and rejects new peers", async () => {
		const server = new MemoryServer();
		let accept: ((socket: NativeChildTransportConnection) => void) | undefined;
		const adapter = new NativeChildTransportServerAdapter({
			endpoint: "/injected/peer-drain.sock",
			handle: async () => undefined,
			createServer: (onConnection) => { accept = onConnection; return server; },
			setPermissions: async () => undefined,
			maxPeers: 1,
			preAuthTimeoutMs: 10_000,
		});
		await adapter.start();
		const idle = new MemoryConnection();
		accept?.(idle);
		const excess = new MemoryConnection();
		accept?.(excess);
		assert.equal(excess.destroyed, true, "peer admission is bounded");
		await adapter.close();
		assert.equal(idle.destroyed, true, "close destroys an unauthenticated peer before server drain");
	});

	bounded("cancels pending attachment on peer close and releases a late lease", async () => {
		const server = new MemoryServer();
		let accept: ((socket: NativeChildTransportConnection) => void) | undefined;
		let markAttachStarted!: () => void;
		const attachStarted = new Promise<void>((resolve) => { markAttachStarted = resolve; });
		let resolveAttach!: (detach: () => void) => void;
		const pendingAttach = new Promise<() => void>((resolve) => { resolveAttach = resolve; });
		let detachCalls = 0;
		let notifyDetached!: () => void;
		const detached = new Promise<void>((resolve) => { notifyDetached = resolve; });
		const adapter = new NativeChildTransportServerAdapter({
			endpoint: "/injected/pending-view.sock",
			handle: async () => undefined,
			attachView: async () => { markAttachStarted(); return pendingAttach; },
			createServer: (onConnection) => { accept = onConnection; return server; },
			setPermissions: async () => undefined,
		});
		await adapter.start();
		const client = new NativeChildTransportClient({
			endpoint: "/injected/pending-view.sock", credential: "opaque-token", expected,
			connect: () => {
				const peer = new MemoryConnection();
				const connection = new MemoryClientConnection(peer);
				peer.write = (value: string) => { connection.push(value); return true; };
				accept?.(peer);
				queueMicrotask(() => connection.emit("connect"));
				return connection;
			},
		});
		const attached = client.attachRootView(() => undefined);
		await attachStarted;
		await adapter.close();
		await assert.rejects(attached, /unavailable/);
		resolveAttach(() => { detachCalls++; notifyDetached(); });
		await detached;
		assert.equal(detachCalls, 1, "a lease resolved after disconnect is released immediately");
	});

	bounded("parses split frames and rejects malformed or oversized frames", () => {
		const decoder = new NativeChildFrameDecoder();
		assert.deepEqual(decoder.feed(Buffer.from('{"one":')), []);
		assert.deepEqual(decoder.feed(Buffer.from("1}\n")), [{ value: { one: 1 } }]);
		assert.equal(decoder.finish(), true);
		const malformed = new NativeChildFrameDecoder();
		assert.deepEqual(malformed.feed(Buffer.from("{bad}\n")), [{ error: "invalid_frame" }]);
		const oversized = new NativeChildFrameDecoder();
		assert.deepEqual(oversized.feed(Buffer.from("x".repeat(MAX_NATIVE_CHILD_FRAME_BYTES + 1))), [{ error: "invalid_frame" }]);
		const partial = new NativeChildFrameDecoder();
		partial.feed(Buffer.from('{"partial":'));
		assert.equal(partial.finish(), false);
	});

	bounded("uses the production client and adapter with injected memory connections", async () => {
		const server = new MemoryServer();
		let accept: ((socket: NativeChildTransportConnection) => void) | undefined;
		const adapter = new NativeChildTransportServerAdapter({
			endpoint: "/injected/client.sock",
			handle: async (request) => ({ route: request.expected.threadId, authorized: request.credential === "opaque-token" }),
			createServer: (onConnection) => { accept = onConnection; return server; },
			setPermissions: async () => undefined,
		});
		await adapter.start();
		const selectedRoute = structuredClone(expected);
		const client = new NativeChildTransportClient({
			endpoint: "/injected/client.sock", credential: "opaque-token", expected: selectedRoute,
			connect: () => {
				const peer = new MemoryConnection();
				const connection = new MemoryClientConnection(peer);
				peer.write = (value: string) => { connection.push(value); return true; };
				peer.end = () => { peer.ended = true; connection.emit("end"); };
				accept?.(peer);
				queueMicrotask(() => connection.emit("connect"));
				return connection;
			},
		});
		selectedRoute.threadId = "tampered-after-client-construction";
		assert.deepEqual(await client.request({ type: "bootstrap-ack", requestId: "bootstrap:8" }), { route: "child-thread", authorized: true });
		await adapter.close();
	});

	bounded("attaches an authenticated persistent view, delivers events, and detaches its lease", async () => {
		const server = new MemoryServer();
		let accept: ((socket: NativeChildTransportConnection) => void) | undefined;
		let detachCalls = 0;
		const adapter = new NativeChildTransportServerAdapter({
			endpoint: "/injected/view.sock",
			handle: async () => undefined,
			attachView: async (request, emit) => {
				assert.deepEqual(request.expected, expected);
				assert.equal(request.credential, "opaque-token");
				emit({ type: "root-event", value: "only-root-subscriber" });
				return () => { detachCalls++; };
			},
			createServer: (onConnection) => { accept = onConnection; return server; },
			setPermissions: async () => undefined,
		});
		await adapter.start();
		const events: unknown[] = [];
		let peer: MemoryConnection | undefined;
		const client = new NativeChildTransportClient({
			endpoint: "/injected/view.sock", credential: "opaque-token", expected,
			connect: () => {
				peer = new MemoryConnection();
				const connection = new MemoryClientConnection(peer);
				peer.write = (value: string) => { connection.push(value); return true; };
				accept?.(peer);
				queueMicrotask(() => connection.emit("connect"));
				return connection;
			},
		});
		const detach = await client.attachRootView((event) => events.push(event));
		assert.deepEqual(events, [{ type: "root-event", value: "only-root-subscriber" }]);
		assert.equal(detachCalls, 0);
		detach();
		assert.equal(detachCalls, 1, "closing the client view releases exactly its attachment");
		await adapter.close();
	});

	bounded("accepts bounded root-only configure and validates the ready generation", async () => {
		const server = new MemoryServer();
		let accept: ((socket: NativeChildTransportConnection) => void) | undefined;
		let called = 0;
		const receivedPrompts: string[] = [];
		const adapter = new NativeChildTransportServerAdapter({ endpoint: "/injected/root-configure.sock",
			handle: async (request) => {
				called++;
				assert.equal(request.command.type, "root-configure");
				if (request.command.type === "root-configure") receivedPrompts.push(request.command.launch.appendSystemPrompt ?? "");
				return { accepted: true, generation: 4 };
			},
			createServer: (onConnection) => { accept = onConnection; return server; }, setPermissions: async () => undefined,
		});
		await adapter.start();
		const connect = () => {
			const peer = new MemoryConnection();
			const connection = new MemoryClientConnection(peer);
			peer.write = (value: string) => { connection.push(value); return true; };
			peer.end = () => { peer.ended = true; connection.emit("end"); };
			accept?.(peer); queueMicrotask(() => connection.emit("connect")); return connection;
		};
		const rootExpected = {
			kind: "ordinary-root" as const, threadId: "root", providerThreadId: "provider-root",
			placement: { parentThreadId: null, projectId: "project", environmentId: "environment", hostId: "host", providerId: "pi-durable" as const },
		};
		const root = new NativeChildTransportClient({ endpoint: "/injected/root-configure.sock", credential: "opaque-token", expected: rootExpected, connect });
		const configure = { type: "root-configure" as const, launch: { cwd: "/workspace", model: { provider: "fixture", modelId: "model" }, thinking: "none", environment: { FEATURE: "on" } } };
		assert.deepEqual(await root.request({ ...configure, launch: { ...configure.launch, appendSystemPrompt: "Instruction one.\nInstruction two." } }), { accepted: true, generation: 4 }, "inline instructions must survive the transport");
		assert.deepEqual(await root.request({ ...configure, launch: { ...configure.launch, appendSystemPrompt: "/workspace/prompt.md" } }), { accepted: true, generation: 4 }, "path-form instructions use the same explicit text-or-path field");
		assert.deepEqual(receivedPrompts, ["Instruction one.\nInstruction two.", "/workspace/prompt.md"]);
		const child = new NativeChildTransportClient({ endpoint: "/injected/root-configure.sock", credential: "opaque-token", expected, connect });
		await assert.rejects(child.request(configure), /denied/);
		assert.equal(called, 2, "child grant cannot configure root");
		const duplicate = new MemoryConnection();
		accept?.(duplicate);
		duplicate.push(JSON.stringify({ id: "duplicate", credential: "opaque-token", expected: rootExpected, command: {
			...configure, launch: { ...configure.launch, appendSystemPrompt: "inline", appendSystemPromptPath: "/workspace/prompt.md" },
		} }) + "\n");
		assert.equal(JSON.parse(duplicate.writes[0]!).ok, false, "duplicate text/path forms must be rejected by the strict codec");
		assert.equal(called, 2);
		await assert.rejects(root.request({ ...configure, launch: { ...configure.launch, appendSystemPrompt: "x".repeat(16_385) } }), /denied/);
		await assert.rejects(root.request({ ...configure, launch: { ...configure.launch, environment: { HUGE: "x".repeat(70_000) } } }), /denied/);
		assert.equal(called, 2, "oversized prompt or root context must fail before dispatch");
		await adapter.close();
	});

	bounded("notifies one post-ack disconnect and suppresses intentional detach without aborting work", async () => {
		const server = new MemoryServer();
		let accept: ((socket: NativeChildTransportConnection) => void) | undefined;
		let detached = 0;
		const adapter = new NativeChildTransportServerAdapter({
			endpoint: "/injected/disconnect.sock", handle: async () => undefined,
			attachView: async () => () => { detached++; },
			createServer: (onConnection) => { accept = onConnection; return server; }, setPermissions: async () => undefined,
		});
		await adapter.start();
		let peer: MemoryConnection | undefined;
		const client = new NativeChildTransportClient({ endpoint: "/injected/disconnect.sock", credential: "opaque-token", expected,
			connect: () => {
				peer = new MemoryConnection();
				const connection = new MemoryClientConnection(peer);
				peer.write = (value: string) => { connection.push(value); return true; };
				accept?.(peer); queueMicrotask(() => connection.emit("connect")); return connection;
			},
		});
		const reasons: string[] = [];
		const detach = await client.attachRootView(() => undefined, (reason) => reasons.push(reason));
		peer?.destroy();
		assert.deepEqual(reasons, ["closed"]);
		assert.equal(detached, 1);
		detach();
		assert.deepEqual(reasons, ["closed"]);
		const second = await client.attachRootView(() => undefined, (reason) => reasons.push(reason));
		second();
		peer?.destroy();
		assert.deepEqual(reasons, ["closed"], "intentional detach is not a lost view");
		await client.attachRootView(() => undefined, (reason) => reasons.push(reason));
		peer?.other?.push("{broken}\n");
		assert.deepEqual(reasons, ["closed", "error"], "a malformed post-ack frame invalidates the view once");
		await adapter.close();
	});

	bounded("reassembles oversized UTF-8 history and tool results without invalid-frame disconnect", async () => {
		const server = new MemoryServer();
		let accept: ((socket: NativeChildTransportConnection) => void) | undefined;
		const payload = "🧭".repeat(25_000);
		const adapter = new NativeChildTransportServerAdapter({
			endpoint: "/injected/large-view.sock", handle: async () => undefined,
			attachView: async (_request, emit) => { emit({ type: "message_end", text: payload }); emit({ type: "tool_execution_end", result: payload }); return () => undefined; },
			createServer: (onConnection) => { accept = onConnection; return server; }, setPermissions: async () => undefined,
		});
		await adapter.start();
		const received: unknown[] = [];
		let peer: MemoryConnection | undefined;
		const client = new NativeChildTransportClient({ endpoint: "/injected/large-view.sock", credential: "opaque-token", expected,
			connect: () => {
				peer = new MemoryConnection();
				const connection = new MemoryClientConnection(peer);
				peer.write = (value: string) => { peer?.writes.push(value); connection.push(value); return true; };
				accept?.(peer); queueMicrotask(() => connection.emit("connect")); return connection;
			},
		});
		const detach = await client.attachRootView((event) => received.push(event));
		assert.deepEqual(received, [{ type: "message_end", text: payload }, { type: "tool_execution_end", result: payload }]);
		assert.equal(peer?.destroyed, false);
		assert.ok(peer?.writes.every((line) => Buffer.byteLength(line) <= MAX_NATIVE_CHILD_FRAME_BYTES));
		detach();
		await adapter.close();
	});

	bounded("serves only validated bounded requests through the production adapter and hides auth failures", async () => {
		const server = new MemoryServer();
		let dispatched = 0;
		const adapter = new NativeChildTransportServerAdapter({
			endpoint: "/injected/plugin-owned.sock",
			handle: async (request) => { dispatched++; assert.equal(request.credential, "opaque-token"); return { accepted: true }; },
			createServer: (onConnection) => { server.on("connection-test", onConnection); return server; },
			setPermissions: async () => undefined,
		});
		await adapter.start();
		assert.equal(server.listening, true);
		const accepted = new MemoryConnection();
		server.emit("connection-test", accepted);
		accepted.push(frame("request-1", { type: "bootstrap-ack", requestId: "bootstrap:8" }));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(JSON.parse(accepted.writes[0]!), { id: "request-1", ok: true, data: { accepted: true } });
		assert.equal(accepted.ended, true);
		assert.equal(dispatched, 1);

		const malformed = new MemoryConnection();
		server.emit("connection-test", malformed);
		malformed.push(frame("request-2", { type: "prompt", message: "must be rejected" }));
		assert.equal(JSON.parse(malformed.writes[0]!).ok, false);
		assert.equal(dispatched, 1);

		const rejected = new MemoryConnection();
		const rejectingAdapter = new NativeChildTransportServerAdapter({
			endpoint: "/injected/plugin-owned-2.sock",
			handle: async () => { throw new Error("denied opaque-token"); },
			createServer: (onConnection) => { server.on("connection-reject", onConnection); return server; },
			setPermissions: async () => undefined,
		});
		await rejectingAdapter.start();
		server.emit("connection-reject", rejected);
		rejected.push(frame("request-3", { type: "bootstrap-ack", requestId: "bootstrap:8" }));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(JSON.parse(rejected.writes[0]!), { id: "request-3", ok: false, error: "denied" });
		assert.equal(rejected.writes[0]!.includes("opaque-token"), false);
		await adapter.close();
		await rejectingAdapter.close();
	});
});
