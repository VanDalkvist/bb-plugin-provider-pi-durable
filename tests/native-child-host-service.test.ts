import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NativeChildHostService } from "../src/host/native-child-host-service.ts";
import { NativeChildTransportClient } from "../src/host/native-child-transport.ts";
import type { NativeChildTransportClientConnection, NativeChildTransportConnection, NativeChildTransportOptions, NativeChildTransportServer } from "../src/host/native-child-transport.ts";
import type { RunnerProcessOptions } from "../src/host/runner-process.ts";
import { RunnerProcessDriver } from "../src/host/shared-runner.ts";
import { SharedOwnerRegistry, type DurableOwnerIdentity, type ObservedExit } from "../src/host/shared-owner.ts";
import type { NativeChildRoute, OrdinaryRootRoute } from "../src/native-child-contract.ts";

const identity: DurableOwnerIdentity = { durableSessionId: "durable-session", conversationId: 0 };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

class MemorySocket extends EventEmitter implements NativeChildTransportConnection, NativeChildTransportClientConnection {
	peer?: MemorySocket;
	write(data: string): boolean { this.peer?.emit("data", Buffer.from(data)); return true; }
	end(): void { this.emit("end"); this.peer?.emit("end"); }
	destroy(): void { this.emit("close"); this.peer?.emit("close"); }
}

class MemoryListener extends EventEmitter implements NativeChildTransportServer {
	private accept?: (socket: NativeChildTransportConnection) => void;
	listen(_endpoint: string, listener: () => void): this { listener(); return this; }
	close(callback?: (error?: Error) => void): this { callback?.(); return this; }
	connect(): MemorySocket {
		const server = new MemorySocket();
		const client = new MemorySocket();
		server.peer = client;
		client.peer = server;
		this.accept?.(server);
		queueMicrotask(() => client.emit("connect"));
		return client;
	}
	setAcceptor(accept: (socket: NativeChildTransportConnection) => void): void { this.accept = accept; }
}

async function configureStagedRoot(descriptor: { endpoint: string; credential: string }, route: OrdinaryRootRoute, listener: MemoryListener, cwd: string): Promise<{ accepted: true; generation: number }> {
	const client = new NativeChildTransportClient({ endpoint: descriptor.endpoint, credential: descriptor.credential, expected: route, connect: () => listener.connect() });
	return await client.request({ type: "root-configure", launch: { cwd, model: { provider: "provider", modelId: "model" }, thinking: "high", environment: { SAFE: "value" } } }) as { accepted: true; generation: number };
}

describe("retained host's RunnerProcess driver capabilities", () => {
	it("releases a prepared view when RPC cancellation arrives before runner readiness", { timeout: 2000 }, async () => {
		const started = deferred<RunnerProcessOptions>();
		const exit = deferred<ObservedExit>();
		const rpc = new AbortController();
		let releasedViews = 0;
		let closedInputs = 0;
		const acquireRoot = SharedOwnerRegistry.prototype.acquireRoot;
		SharedOwnerRegistry.prototype.acquireRoot = async function (args) {
			const lease = await acquireRoot.call(this, args);
			return { ...lease, release: () => { releasedViews++; lease.release(); } };
		};
		const context = {
			signal: rpc.signal,
			lifecycle: { signal: new AbortController().signal },
			experimental_paths: { dataDir: "/memory/data", tempDir: "/memory/temp" },
			experimental_retainWorker: () => ({ dispose: async () => undefined }),
		};
		const service = new NativeChildHostService(context.experimental_paths, {
			transport: { createServer: () => new MemoryListener(), setPermissions: async () => undefined },
			createRunner: (options) => {
				started.resolve(options);
				return {
					observedExit: exit.promise,
					requestOk: async () => ({ durableSessionId: "session", conversationId: ROOT_CONVERSATION_ID }),
					closeInput: () => { closedInputs++; exit.resolve({ kind: "exit", code: 0, signal: null }); },
				};
			},
		});
		try {
			const preparation = service.prepareRoot({
				route: { kind: "ordinary-root", threadId: "cancelled-root", providerThreadId: "provider-cancelled", placement: { parentThreadId: null, projectId: "project", environmentId: "environment", hostId: "host", providerId: "pi-durable" } },
				durableSessionId: "session", launch: { cwd: "/memory", sessionDirectory: "/memory/session" },
			}, context);
			const staged = await preparation;
			assert.equal(staged.phase, "pending");
			assert.equal(staged.generation, 0);
			rpc.abort();
			assert.equal(closedInputs, 0, "cancelled staging must not start native owner work");
			assert.equal(releasedViews, 0, "staging never acquires a view");
		} finally {
			await service.dispose();
			SharedOwnerRegistry.prototype.acquireRoot = acquireRoot;
		}
	});
	it("keeps trusted configuration when one of two coalesced preparations is cancelled", { timeout: 2000 }, async () => {
		const started = deferred<RunnerProcessOptions>();
		const exit = deferred<ObservedExit>();
		const rpc = new AbortController();
		let allocations = 0;
		const context = {
			signal: rpc.signal, lifecycle: { signal: new AbortController().signal },
			experimental_paths: { dataDir: "/memory/data", tempDir: "/memory/temp" },
			experimental_retainWorker: () => ({ dispose: async () => undefined }),
		};
		const service = new NativeChildHostService(context.experimental_paths, {
			transport: { createServer: () => new MemoryListener(), setPermissions: async () => undefined },
			createRunner: (options) => {
				allocations++;
				started.resolve(options);
				return {
					observedExit: exit.promise,
					requestOk: async () => ({ durableSessionId: "session", conversationId: ROOT_CONVERSATION_ID }),
					closeInput: () => exit.resolve({ kind: "exit", code: 0, signal: null }),
				};
			},
		});
		const input = {
			route: { kind: "ordinary-root", threadId: "shared-root", providerThreadId: "provider-shared", placement: { parentThreadId: null, projectId: "project", environmentId: "environment", hostId: "host", providerId: "pi-durable" } } satisfies OrdinaryRootRoute,
			durableSessionId: "session", launch: { cwd: "/memory", sessionDirectory: "/memory/session" },
		};
		const secondContext = { ...context, signal: new AbortController().signal };
		try {
			const first = service.prepareRoot(input, context);
			const second = service.prepareRoot(input, secondContext);
			rpc.abort();
			await Promise.all([assert.rejects(first, /denied/), second]);
			assert.equal(allocations, 0, "cancelled coalesced staging never starts a runner");
			await assert.rejects(service.prepareRoot({ ...input, launch: { ...input.launch, cwd: "/different" } }, secondContext), /denied/, "one cancelled caller must not erase the staged root identity");
		} finally { await service.dispose(); }
	});

	it("drains the owner even when transport disposal fails", { timeout: 2000 }, async () => {
		const exit = deferred<ObservedExit>();
		let closedInputs = 0;
		let releasedRetentions = 0;
		const listener = new MemoryListener();
		listener.close = (callback) => { callback?.(new Error("transport close failed")); return listener; };
		const context = {
			signal: new AbortController().signal, lifecycle: { signal: new AbortController().signal },
			experimental_paths: { dataDir: "/memory/data", tempDir: "/memory/temp" },
			experimental_emitSignal: async () => undefined,
			experimental_retainWorker: () => ({ dispose: async () => { releasedRetentions++; } }),
		};
		const service = new NativeChildHostService(context.experimental_paths, {
			transport: { createServer: (accept) => { listener.setAcceptor(accept); return listener; }, setPermissions: async () => undefined },
			attestLaunch: async () => undefined,
			createRunner: (options) => {
				queueMicrotask(() => options.onChannelMessage?.({ kind: "ready" }));
				return {
					observedExit: exit.promise,
					requestOk: async () => ({ durableSessionId: "session", conversationId: ROOT_CONVERSATION_ID }),
					closeInput: () => { closedInputs++; exit.resolve({ kind: "exit", code: 0, signal: null }); },
				};
			},
		});
		try {
			const root: OrdinaryRootRoute = { kind: "ordinary-root", threadId: "drain-root", providerThreadId: "provider-drain", placement: { parentThreadId: null, projectId: "project", environmentId: "environment", hostId: "host", providerId: "pi-durable" } };
			const staged = await service.prepareRoot({ route: root, durableSessionId: "session", launch: { cwd: "/memory", sessionDirectory: "/memory/session" } }, context);
			await configureStagedRoot(staged, root, listener, "/memory");
			const disposed = service.dispose();
			assert.equal(service.dispose(), disposed, "all callers share the complete teardown result");
			await assert.rejects(disposed, /transport close failed/);
			assert.equal(closedInputs, 1, "transport failure must not leave the retained owner running");
			assert.equal(releasedRetentions, 2, "staged and owner retention release despite transport failure");
		} finally { exit.resolve({ kind: "exit", code: 0, signal: null }); }
	});

	it("observes lifecycle drain failures without an unhandled rejection and preserves the disposal error", { timeout: 2000 }, async () => {
		const exit = deferred<ObservedExit>();
		const lifecycle = new AbortController();
		const context = {
			signal: new AbortController().signal, lifecycle: { signal: lifecycle.signal },
			experimental_paths: { dataDir: "/memory/data", tempDir: "/memory/temp" },
			experimental_retainWorker: () => ({ dispose: async () => { throw new Error("SDK retention release failed"); } }),
		};
		const service = new NativeChildHostService(context.experimental_paths, {
			transport: { createServer: () => new MemoryListener(), setPermissions: async () => undefined },
			createRunner: (options) => {
				queueMicrotask(() => options.onChannelMessage?.({ kind: "ready" }));
				return {
					observedExit: exit.promise,
					requestOk: async () => ({ durableSessionId: "session", conversationId: ROOT_CONVERSATION_ID }),
					closeInput: () => exit.resolve({ kind: "exit", code: 0, signal: null }),
				};
			},
		});
		await service.prepareRoot({
			route: { kind: "ordinary-root", threadId: "lifecycle-root", providerThreadId: "provider-lifecycle", placement: { parentThreadId: null, projectId: "project", environmentId: "environment", hostId: "host", providerId: "pi-durable" } },
			durableSessionId: "session", launch: { cwd: "/memory", sessionDirectory: "/memory/session" },
		}, context);
		lifecycle.abort();
		await new Promise<void>((resolve) => setImmediate(resolve));
		await assert.rejects(service.dispose(), /SDK retention release failed/, "the host's explicit dispose still propagates the retained error");
	});

	it("allocates one runner and fences requests/events by exact owner identity and generation", { timeout: 2000 }, async () => {
		let allocations = 0;
		let options: RunnerProcessOptions | undefined;
		const exit = deferred<ObservedExit>();
		const driver = new RunnerProcessDriver(() => ({ cwd: "/workspace", args: ["--cwd", "/workspace"], env: { FOO: "bar" } }), (provided) => {
			allocations++;
			options = provided;
			queueMicrotask(() => provided.onChannelMessage?.({ kind: "ready" }));
			return {
				observedExit: exit.promise,
				requestOk: async (command: Record<string, unknown>) => command.type === "get_state" ? identity : command,
				closeInput: () => undefined,
			};
		});
		const process = driver.start(identity, 4);
		assert.deepEqual(await process.ready, identity);
		assert.equal(allocations, 1);
		assert.deepEqual(options && { cwd: options.cwd, args: options.args, env: options.env }, { cwd: "/workspace", args: ["--cwd", "/workspace"], env: { FOO: "bar" } });
		await assert.rejects(driver.request(identity, 3, { type: "abort" }), /capability denied/);
		await assert.rejects(driver.request({ ...identity, durableSessionId: "other" }, 4, { type: "abort" }), /capability denied/);
		assert.deepEqual(await driver.request(identity, 4, { type: "get_session_stats" }), { type: "get_session_stats" });
		const seen: unknown[] = [];
		const unsubscribe = driver.subscribeRootEvents(identity, 4, (event) => seen.push(event));
		options?.onEvent?.({ type: "root-event" });
		assert.deepEqual(seen, [{ type: "root-event" }]);
		unsubscribe();
		assert.throws(() => driver.subscribeRootEvents(identity, 3, () => undefined), /capability denied/);
		exit.resolve({ kind: "exit", code: 0, signal: null });
		await process.observedExit;
		await assert.rejects(driver.request(identity, 4, { type: "abort" }), /capability denied/);
	});

	it("prepares one retained owner for an ordinary child-root and two verified native views", { timeout: 2000 }, async () => {
		const listener = new MemoryListener();
		let runnerOptions: RunnerProcessOptions | undefined;
		let allocations = 0;
		let retentionLeases = 0;
		let releases = 0;
		const runnerExits: Array<ReturnType<typeof deferred<ObservedExit>>> = [];
		const lifecycle = new AbortController();
		const context = {
			signal: new AbortController().signal,
			lifecycle: { signal: lifecycle.signal },
			experimental_paths: { dataDir: "/memory/plugin-data", tempDir: "/memory/plugin-temp" },
			experimental_emitSignal: async (signal: string, value: unknown) => { if (signal === "nativeChildDiscovered") emittedDiscoveries.push(value); },
			experimental_retainWorker: () => {
				retentionLeases++;
				return { dispose: async () => { releases++; } };
			},
		};
		let tamperIntent = false;
		const intentCommands: unknown[] = [];
		const emittedDiscoveries: unknown[] = [];
		const stopCommands: unknown[] = [];
		const transport: Omit<NativeChildTransportOptions, "endpoint" | "handle" | "attachView"> = {
			createServer: (accept) => { listener.setAcceptor(accept); return listener; },
			setPermissions: async () => undefined,
		};
		const service = new NativeChildHostService(context.experimental_paths, {
			transport,
			attestLaunch: async () => undefined,
			createRunner: (options) => {
				allocations++;
				const exit = deferred<ObservedExit>();
				runnerExits.push(exit);
				runnerOptions = options;
				queueMicrotask(() => options.onChannelMessage?.({ kind: "ready" }));
				return {
					observedExit: exit.promise,
					requestOk: async (command) => {
						if (command.type === "get_state") return { durableSessionId: "session", conversationId: ROOT_CONVERSATION_ID };
						if (command.type === "native-child-discover") return [{ parentThreadId: "root-thread", durableSessionId: "session", parentConversationId: ROOT_CONVERSATION_ID, childConversationId: 18, taskId: 8, requestId: "subagent:8", phase: "submitted" }];
						if (command.type === "native-child-intent") {
							intentCommands.push(command);
							return { valid: true, phase: tamperIntent ? "submitted" : "intent", durableSessionId: command.durableSessionId, parentConversationId: command.parentConversationId, childConversationId: command.childConversationId, taskId: command.taskId, requestId: `subagent:${command.taskId}` };
						}
						if (command.type === "native-child-stop") {
							stopCommands.push(command);
							return { accepted: true, requestId: `subagent:${command.taskId}`, conversationId: command.childConversationId };
						}
						if (command.type === "native-child-identity") return { valid: true, requestId: `subagent:${command.taskId}` };
						return { accepted: true, type: command.type };
					},
					closeInput: () => exit.resolve({ kind: "exit", code: 0, signal: null }),
				};
			},
		});
		const root: OrdinaryRootRoute = {
			kind: "ordinary-root", threadId: "root-thread", providerThreadId: "provider-root",
			placement: { parentThreadId: "outer-parent", projectId: "project", environmentId: "environment", hostId: "host", providerId: "pi-durable" },
		};
		const descriptor = await service.prepareRoot({
			route: root,
			durableSessionId: "session",
			launch: { cwd: "/memory/workspace", sessionDirectory: "/memory/session", environment: { SAFE: "value" } },
		}, context);
		assert.equal(descriptor.phase, "pending");
		assert.equal(allocations, 0, "staging cannot execute restored native work");
		assert.deepEqual(await configureStagedRoot(descriptor, root, listener, "/memory/workspace"), { accepted: true, generation: 1 });
		assert.equal(allocations, 1);
		assert.equal(retentionLeases, 2);
		const placement = { ...root.placement, parentThreadId: root.threadId };
		const childRoute = (index: number): NativeChildRoute => ({
			kind: "native-child",
			threadId: `child-${index}`,
			providerThreadId: `provider-child-${index}`,
			placement,
			child: { durableSessionId: "session", taskId: index as NativeChildRoute["child"]["taskId"], conversationId: (index + 10) as NativeChildRoute["child"]["conversationId"], requestId: `subagent:${index}` },
			bootstrapRequestId: `bootstrap:${index}`,
		});
		const childOne = childRoute(8);
		const childTwo = childRoute(9);
		const intentRequest = { durableSessionId: "session", parentThreadId: root.threadId, childConversationId: childOne.child.conversationId, taskId: childOne.child.taskId };
		assert.deepEqual(await service.inspectNativeChildIntent(intentRequest, context), {
			valid: true, phase: "intent", durableSessionId: "session", parentConversationId: ROOT_CONVERSATION_ID,
			childConversationId: childOne.child.conversationId, taskId: childOne.child.taskId, requestId: childOne.child.requestId,
		});
		assert.equal(intentCommands.length, 1);
		assert.deepEqual(await service.discoverNativeChildren({ parentThreadId: "root-thread", durableSessionId: "session", generation: 1 }, context), [{ parentThreadId: "root-thread", durableSessionId: "session", parentConversationId: ROOT_CONVERSATION_ID, childConversationId: 18, taskId: 8, requestId: "subagent:8", phase: "submitted" }]);
		await assert.rejects(service.discoverNativeChildren({ parentThreadId: "forged", durableSessionId: "session", generation: 1 }, context), /denied/);
		runnerOptions?.onEvent?.({ type: "native-child-discovered", discovery: { parentThreadId: "root-thread", durableSessionId: "session", parentConversationId: ROOT_CONVERSATION_ID, childConversationId: 18, taskId: 8, requestId: "subagent:8", phase: "intent" } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(emittedDiscoveries.length, 1);
		await assert.rejects(service.inspectNativeChildIntent({ ...intentRequest, parentThreadId: "unrelated-parent" }, context), /denied/);
		await assert.rejects(service.inspectNativeChildIntent({ ...intentRequest, durableSessionId: "other-session" }, context), /denied/);
		assert.equal(intentCommands.length, 1, "wrong parent/session must be denied before touching the runner");
		tamperIntent = true;
		await assert.rejects(service.inspectNativeChildIntent(intentRequest, context), /denied/, "an incorrectly phased proof must not be accepted");
		tamperIntent = false;
		assert.equal(allocations, 1, "pre-submit inspection never starts another executor");
		const childOneDescriptor = await service.registerNativeChild({ route: childOne }, context);
		const childTwoDescriptor = await service.registerNativeChild({ route: childTwo }, context);
		assert.equal(childOneDescriptor.generation, 1);
		assert.equal(childTwoDescriptor.generation, 1);
		assert.equal(allocations, 1, "root and both child views use one allocated runner");

		const connect = (endpoint: string) => {
			assert.equal(endpoint, descriptor.endpoint);
			return listener.connect();
		};
		const rootClient = new NativeChildTransportClient({ endpoint: descriptor.endpoint, credential: descriptor.credential, expected: root, connect });
		assert.deepEqual(await rootClient.request({ type: "root", command: { type: "get_session_stats" } }), { accepted: true, type: "get_session_stats" });
		const rootEvents: unknown[] = [];
		const detachRoot = await rootClient.attachRootView((event) => rootEvents.push(event));
		runnerOptions?.onEvent?.({ type: "root-event", value: "parent" });
		runnerOptions?.onEvent?.({ type: "native-child-discovered", discovery: emittedDiscoveries[0] });
		assert.deepEqual(rootEvents, [{ type: "root-event", value: "parent" }]);

		const childClient = new NativeChildTransportClient({ endpoint: descriptor.endpoint, credential: childOneDescriptor.credential, expected: childOne, connect });
		assert.deepEqual(await childClient.request({ type: "bootstrap-ack", requestId: childOne.bootstrapRequestId }), { accepted: true, requestId: childOne.bootstrapRequestId });
		assert.deepEqual(await childClient.request({ type: "bootstrap-ack", requestId: childOne.bootstrapRequestId }), { accepted: true, requestId: childOne.bootstrapRequestId }, "bootstrap replay does not submit or allocate another child");
		await assert.rejects(childClient.request({ type: "bootstrap-ack", requestId: "forged-bootstrap" }), /denied/);
		await assert.rejects(childClient.request({ type: "root", command: { type: "prompt", message: "not a child control" } }), /denied/);
		await assert.rejects(rootClient.request({ type: "child-stop" }), /denied/);
		assert.equal(stopCommands.length, 0, "root credentials cannot masquerade as a child stop grant");
		const injectedTarget = { type: "child-stop", taskId: childTwo.child.taskId } satisfies { type: "child-stop"; taskId: number };
		await assert.rejects(childClient.request(injectedTarget), /denied|invalid_frame/);
		assert.equal(stopCommands.length, 0, "extra client-supplied targets fail boundary validation");
		assert.deepEqual(await childClient.request({ type: "child-stop" }), { accepted: true, requestId: childOne.child.requestId, conversationId: childOne.child.conversationId });
		assert.deepEqual(stopCommands, [{ type: "native-child-stop", durableSessionId: "session", parentConversationId: ROOT_CONVERSATION_ID, childConversationId: childOne.child.conversationId, taskId: childOne.child.taskId }], "the target comes exclusively from the redeemed child's route");
		assert.deepEqual(await rootClient.request({ type: "root", command: { type: "get_session_stats" } }), { accepted: true, type: "get_session_stats" }, "child stop leaves the parent runner admitted");
		const childEvents: unknown[] = [];
		const detachChild = await childClient.attachRootView((event) => childEvents.push(event));
		runnerOptions?.onEvent?.({ type: "root-event", value: "parent-only" });
		assert.deepEqual(rootEvents, [{ type: "root-event", value: "parent" }, { type: "root-event", value: "parent-only" }]);
		assert.deepEqual(childEvents, [], "native child view receives no root event projection");
		detachChild();
		detachRoot();
		assert.equal(allocations, 1, "view disconnect does not stop or replace native work");

		await assert.rejects(service.prepareRoot({
			route: root, durableSessionId: "other-session",
			launch: { cwd: "/memory/workspace", sessionDirectory: "/memory/other-session" },
		}, context), /denied/);
		const wrongPlacement = { ...childTwo, threadId: "wrong-placement", placement: { ...placement, projectId: "other-project" } };
		await assert.rejects(service.registerNativeChild({ route: wrongPlacement }, context), /denied/);
		const invalidIdentity = { ...childTwo, threadId: "invalid-identity", child: { ...childTwo.child, requestId: "subagent:wrong" } };
		await assert.rejects(service.registerNativeChild({ route: invalidIdentity }, context), /denied/);
		assert.deepEqual(await rootClient.request({ type: "root", command: { type: "get_session_stats" } }), { accepted: true, type: "get_session_stats" }, "rejected preparations do not poison the valid root route");
		runnerExits[0]!.resolve({ kind: "exit", code: 0, signal: null });
		await runnerExits[0]!.promise;
		const replacement = await service.prepareRoot({ route: root, durableSessionId: "session", launch: { cwd: "/memory/workspace", sessionDirectory: "/memory/session", environment: { SAFE: "value" } } }, context);
		assert.equal(replacement.phase, "pending");
		const replacementReady = await configureStagedRoot(replacement, root, listener, "/memory/workspace");
		assert.ok(replacementReady.generation > 1);
		assert.equal(allocations, 2);
		await assert.rejects(rootClient.request({ type: "root", command: { type: "get_session_stats" } }), /denied/);
		await assert.rejects(childClient.request({ type: "bootstrap-ack", requestId: childOne.bootstrapRequestId }), /denied/);
		await assert.rejects(childClient.request({ type: "child-stop" }), /denied/);
		assert.equal(stopCommands.length, 1, "a stale-generation child grant never reaches the replacement runner");
		await service.dispose();
		assert.ok(releases >= 2, "staged and owner retention release after shutdown");
		await assert.rejects(service.dispose().then(() => service.prepareRoot({ route: root, durableSessionId: "session", launch: { cwd: "/memory", sessionDirectory: "/memory/session" } }, context)), /denied/);
	});

	it("attests complete bridge context before opening the root and rejects conflicting or foreign grants", async () => {
		const listener = new MemoryListener();
		const exit = deferred<ObservedExit>();
		const attested: string[] = [];
		const ready: unknown[] = [];
		let options: RunnerProcessOptions | undefined;
		const route: OrdinaryRootRoute = { kind: "ordinary-root", threadId: "context-root", providerThreadId: "native-context", placement: { parentThreadId: null, projectId: "project", environmentId: "environment", hostId: "host", providerId: "pi-durable" } };
		const context = { signal: new AbortController().signal, lifecycle: { signal: new AbortController().signal },
			experimental_paths: { dataDir: "/memory/data", tempDir: "/memory/temp" },
			experimental_retainWorker: () => ({ dispose: async () => undefined }),
			experimental_emitSignal: async (type: string, value: unknown) => { if (type === "nativeRootReady") ready.push(value); } };
		const service = new NativeChildHostService(context.experimental_paths, {
			transport: { createServer: (accept) => { listener.setAcceptor(accept); return listener; }, setPermissions: async () => undefined },
			attestLaunch: async (_sid, launch) => { attested.push(JSON.stringify(launch)); },
			createRunner: (created) => {
				options = created;
				queueMicrotask(() => created.onChannelMessage?.({ kind: "ready" }));
				return { observedExit: exit.promise, requestOk: async () => ({ durableSessionId: "context", conversationId: ROOT_CONVERSATION_ID }),
					closeInput: () => exit.resolve({ kind: "exit", code: 0, signal: null }) };
			},
		});
		try {
			const staged = await service.prepareRoot({ route, durableSessionId: "context", launch: { cwd: "/memory/workspace", sessionDirectory: "/memory/context" } }, context);
			assert.equal(staged.generation, 0);
			const retry = await service.prepareRoot({ route, durableSessionId: "context", launch: { cwd: "/memory/workspace", sessionDirectory: "/memory/context" } }, context);
			assert.equal(retry.credential, staged.credential, "repeated resolver must not rotate a live root grant");
			assert.equal(options, undefined, "prepare must not open Durable or resume restored work");
			assert.deepEqual(service.rootReadiness({ parentThreadId: route.threadId, durableSessionId: "context" }, context), { ready: false, generation: 0 });
			const client = new NativeChildTransportClient({ endpoint: staged.endpoint, credential: staged.credential, expected: route, connect: () => listener.connect() });
			const launch = { cwd: "/memory/workspace", model: { provider: "anthropic", modelId: "first-model" }, thinking: "high", appendSystemPrompt: "injected BB instruction", environment: {
				SAFE: "passed", BB_PI_DURABLE_HOST_SOCKET: "spoof", BB_PI_DURABLE_VIEW_CREDENTIAL: "spoof", BB_PI_DURABLE_VIEW_ROUTE: "spoof", BB_PI_DURABLE_PARENT_THREAD_ID: "spoof" } };
			await assert.rejects(client.request({ type: "root-configure", launch: { ...launch, cwd: "/memory/wrong" } }), /denied/);
			assert.equal(options, undefined, "conflicting cwd cannot start a retained runner");
			const configured = await client.request({ type: "root-configure", launch });
			assert.deepEqual(configured, { accepted: true, generation: 1 });
			assert.equal(attested.length, 1);
			assert.equal(options?.cwd, launch.cwd);
			assert.deepEqual(options?.args.slice(-8), ["--provider", "anthropic", "--model", "first-model", "--thinking", "high", "--append-system-prompt", "injected BB instruction"]);
			assert.deepEqual(options?.env, { SAFE: "passed", BB_PI_DURABLE_PARENT_THREAD_ID: route.threadId });
			assert.deepEqual(ready, [{ parentThreadId: route.threadId, durableSessionId: "context", generation: 1 }]);
			assert.deepEqual(await client.request({ type: "root-configure", launch }), configured);
			const restored = await service.prepareRoot({ route, durableSessionId: "context", launch: { cwd: "/memory/workspace", sessionDirectory: "/memory/context" } }, context);
			assert.equal(restored.credential, staged.credential, "ready resolver preserves the exact private grant");
			assert.equal(attested.length, 1, "replayed identical configuration cannot reopen the owner");
			await assert.rejects(client.request({ type: "root-configure", launch: { ...launch, model: { provider: "anthropic", modelId: "changed" } } }), /denied/);
			const wrong = new NativeChildTransportClient({ endpoint: staged.endpoint, credential: staged.credential, expected: { ...route, threadId: "foreign" }, connect: () => listener.connect() });
			await assert.rejects(wrong.request({ type: "root-configure", launch }), /denied/);
			assert.equal(attested.length, 1);
		} finally { await service.dispose(); }
	});

	it("expires an unconfigured root without opening a runner and revokes its pending grant", { timeout: 2000 }, async () => {
		const expired = deferred<void>();
		const listener = new MemoryListener();
		let retained = 0;
		let allocated = 0;
		const route: OrdinaryRootRoute = { kind: "ordinary-root", threadId: "expiring-root", providerThreadId: "expiring-session", placement: { parentThreadId: null, projectId: "project", environmentId: "environment", hostId: "host", providerId: "pi-durable" } };
		const context = { signal: new AbortController().signal, lifecycle: { signal: new AbortController().signal },
			experimental_paths: { dataDir: "/memory/data", tempDir: "/memory/temp" },
			experimental_retainWorker: () => { retained++; return { dispose: async () => { expired.resolve(); } }; },
			experimental_emitSignal: async () => undefined };
		const service = new NativeChildHostService(context.experimental_paths, {
			pendingTimeoutMs: 25,
			transport: { createServer: (accept) => { listener.setAcceptor(accept); return listener; }, setPermissions: async () => undefined },
			attestLaunch: async () => undefined,
			createRunner: () => { allocated++; throw new Error("pending root must not start runner"); },
		});
		try {
			const staged = await service.prepareRoot({ route, durableSessionId: "expiring", launch: { cwd: "/memory", sessionDirectory: "/memory/expiring" } }, context);
			await expired.promise;
			assert.equal(retained, 1, "one staging retention was acquired");
			assert.equal(allocated, 0);
			assert.throws(() => service.rootReadiness({ parentThreadId: route.threadId, durableSessionId: "expiring" }, context), /denied/);
			const client = new NativeChildTransportClient({ endpoint: staged.endpoint, credential: staged.credential, expected: route, connect: () => listener.connect() });
			await assert.rejects(client.request({ type: "root-configure", launch: { cwd: "/memory", model: { provider: "provider", modelId: "model" }, thinking: "high", environment: {} } }), /denied/);
			assert.equal(allocated, 0);
		} finally { await service.dispose(); }
	});
});
