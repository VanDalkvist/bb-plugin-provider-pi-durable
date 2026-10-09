import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineTask, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { NativeChildAuthority } from "../src/host/native-child-authority.ts";
import { SharedOwnerRegistry } from "../src/host/shared-owner.ts";
import type {
	DurableOwnerIdentity,
	ObservedExit,
	OwnerProcess,
	OwnerProcessDriver,
	OwnerRetentionLease,
	SharedOwnerOptions,
} from "../src/host/shared-owner.ts";
import type { NativeChildRoute, NativePlacement, OrdinaryRootRoute } from "../src/native-child-contract.ts";

let harness: Awaited<ReturnType<typeof Harness.open>>;
let conversationId: ConversationId;
let taskId: TaskId;
let unrelatedTaskId: TaskId;

before(async () => {
	const models = createModels();
	harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
	const root = await harness.root(BACKGROUND_CONTEXT);
	conversationId = root.id;
	const testTask = defineTask({
		name: "shared-owner-lifecycle-test",
		version: 1,
		initial: (): { phase: "idle" } => ({ phase: "idle" }),
		phases: { idle: async () => undefined },
		abort: async () => undefined,
	});
	taskId = await root.commit(
		(tx) => tx.createTask(testTask, {}, { ownership: { kind: "conversation" } }),
		BACKGROUND_CONTEXT,
	);
	unrelatedTaskId = await root.commit(
		(tx) => tx.createTask(testTask, {}, { ownership: { kind: "conversation" } }),
		BACKGROUND_CONTEXT,
	);
});

after(async () => {
	await harness.close(BACKGROUND_CONTEXT);
});

const placement: NativePlacement = {
	parentThreadId: "root-thread",
	projectId: "project-one",
	environmentId: "environment-one",
	hostId: "host-one",
	providerId: "pi-durable",
};
const rootPlacement = { ...placement, parentThreadId: null };
const identity: DurableOwnerIdentity = { durableSessionId: "durable-session-one", conversationId: 4 };

function rootRoute(threadId = "root-thread", providerThreadId = "root-provider-thread"): OrdinaryRootRoute {
	return { kind: "ordinary-root", threadId, providerThreadId, placement: rootPlacement };
}

function childRoute(threadId: string, overrides: Partial<NativeChildRoute["child"]> = {}): NativeChildRoute {
	return {
		kind: "native-child",
		threadId,
		providerThreadId: `${threadId}-provider`,
		placement,
		child: {
			durableSessionId: identity.durableSessionId,
			taskId,
			conversationId,
			requestId: `subagent:${threadId}`,
			...overrides,
		},
		bootstrapRequestId: `bootstrap:${threadId}`,
	};
}

class FakeProcess implements OwnerProcess {
	readonly ready: Promise<DurableOwnerIdentity>;
	readonly observedExit: Promise<ObservedExit>;
	closeInputCalls = 0;
	private resolveExit!: (exit: ObservedExit) => void;

	constructor(actualIdentity: DurableOwnerIdentity, ready: Promise<DurableOwnerIdentity> = Promise.resolve(actualIdentity)) {
		this.ready = ready;
		this.observedExit = new Promise((resolve) => { this.resolveExit = resolve; });
	}

	closeInput(): void {
		this.closeInputCalls++;
	}

	exit(code: number | null = 0): void {
		this.resolveExit({ kind: "exit", code, signal: null });
	}
}

class FakeDriver implements OwnerProcessDriver {
	readonly processes: FakeProcess[] = [];
	throwOnStart = false;
	nextReady: Promise<DurableOwnerIdentity> | undefined;

	start(actualIdentity: DurableOwnerIdentity): OwnerProcess {
		if (this.throwOnStart) {
			this.throwOnStart = false;
			throw new Error("factory failed before process allocation");
		}
		const process = new FakeProcess(actualIdentity, this.nextReady);
		this.nextReady = undefined;
		this.processes.push(process);
		return process;
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function setup(options: {
	retain?: () => OwnerRetentionLease | Promise<OwnerRetentionLease>;
	validateChildTask?: SharedOwnerOptions["validateChildTask"];
} = {}) {
	const authority = new NativeChildAuthority();
	const driver = new FakeDriver();
	let retainCount = 0;
	let releaseCount = 0;
	let validateCount = 0;
	const registry = new SharedOwnerRegistry({
		authority,
		driver,
		retain: options.retain ?? (() => {
			retainCount++;
			return { release: () => { releaseCount++; } };
		}),
		validateChildTask: options.validateChildTask ?? ((route, ownerIdentity) => {
			validateCount++;
			return route.child.durableSessionId === ownerIdentity.durableSessionId
				&& route.child.conversationId === conversationId
				&& route.child.taskId === taskId;
		}),
	});
	return {
		registry,
		authority,
		driver,
		counts: () => ({ retainCount, releaseCount, validateCount }),
	};
}

function registerChild(authority: NativeChildAuthority, route: NativeChildRoute): string {
	authority.registerNativeChild(route);
	return authority.issue(route).credential;
}

function acquireChild(registry: SharedOwnerRegistry, route: NativeChildRoute, credential: string) {
	return registry.joinNativeChild({ route, credential });
}

const denied = /Shared Durable owner acquisition denied|Native child authorization denied/;
const boundedTest = (name: string, fn: () => void | Promise<void>) => it(name, { timeout: 2000 }, fn);

describe("shared Durable owner lifecycle", () => {
	boundedTest("coalesces concurrent root acquisition and shares one process across root and two child views", async () => {
		const { registry, authority, driver, counts } = setup();
		const root = rootRoute();
		const [parentView, duplicateRootView] = await Promise.all([
			registry.acquireRoot({ identity, rootRoute: root }),
			registry.acquireRoot({ identity, rootRoute: root }),
		]);
		const first = childRoute("child-one");
		const second = childRoute("child-two");
		const firstView = await acquireChild(registry, first, registerChild(authority, first));
		const secondView = await acquireChild(registry, second, registerChild(authority, second));

		assert.equal(driver.processes.length, 1);
		assert.equal(counts().retainCount, 1);
		assert.deepEqual([parentView.identity.threadId, firstView.identity.threadId, secondView.identity.threadId], ["root-thread", "child-one", "child-two"]);
		assert.equal(duplicateRootView.identity.generation, parentView.identity.generation);
		assert.deepEqual(counts(), { retainCount: 1, releaseCount: 0, validateCount: 2 });
	});

	boundedTest("denies child join before owner creation and rejects cross-session, task, and placement proofs", async () => {
		const { registry, authority, driver, counts } = setup();
		const route = childRoute("child-unowned");
		const credential = registerChild(authority, route);
		await assert.rejects(acquireChild(registry, route, credential), denied);
		assert.equal(driver.processes.length, 0);
		assert.equal(counts().retainCount, 0);

		await registry.acquireRoot({ identity, rootRoute: rootRoute() });
		const crossSession = childRoute("child-cross-session", { durableSessionId: "another-session" });
		await assert.rejects(acquireChild(registry, crossSession, registerChild(authority, crossSession)), denied);
		const wrongTask = childRoute("child-wrong-task", { taskId: unrelatedTaskId });
		await assert.rejects(acquireChild(registry, wrongTask, registerChild(authority, wrongTask)), denied);
		const wrongPlacement = { ...childRoute("child-wrong-placement"), placement: { ...placement, projectId: "other-project" } };
		await assert.rejects(acquireChild(registry, wrongPlacement, registerChild(authority, wrongPlacement)), denied);
		assert.equal(driver.processes.length, 1);
		assert.equal(counts().validateCount, 1);
	});

	boundedTest("view release never aborts, closes, or kills owner work, even after the final view", async () => {
		const { registry, authority, driver } = setup();
		const parent = await registry.acquireRoot({ identity, rootRoute: rootRoute() });
		const firstRoute = childRoute("child-release-one");
		const secondRoute = childRoute("child-release-two");
		const first = await acquireChild(registry, firstRoute, registerChild(authority, firstRoute));
		const second = await acquireChild(registry, secondRoute, registerChild(authority, secondRoute));
		const process = driver.processes[0]!;

		parent.release();
		first.release();
		second.release();
		await Promise.resolve();
		assert.equal(process.closeInputCalls, 0);
		assert.equal(registry.lifecycle(identity)?.kind, "ready");
		assert.equal(registry.lifecycle({ ...identity, conversationId: 99 }), undefined);
		await assert.rejects(registry.shutdown({ ...identity, conversationId: 99 }), denied);
		assert.equal(process.closeInputCalls, 0);
	});

	boundedTest("waits for actual exit before same-session restart and does not replay any root prompt", async () => {
		const { registry, driver, counts } = setup();
		const first = await registry.acquireRoot({ identity, rootRoute: rootRoute() });
		first.release();
		const firstProcess = driver.processes[0]!;
		assert.equal(counts().retainCount, 1);
		firstProcess.exit(1);
		await firstProcess.observedExit;
		await Promise.resolve();
		await Promise.resolve();
		const restarted = await registry.acquireRoot({ identity, rootRoute: rootRoute() });
		assert.equal(driver.processes.length, 2);
		assert.equal(restarted.identity.generation, 2);
		assert.equal(counts().releaseCount, 1);
		assert.equal(firstProcess.closeInputCalls, 0);
	});

	boundedTest("fences replacement after startup failure or runner error until exit is observed", async () => {
		const { registry, driver, counts } = setup();
		let rejectReady!: (error: Error) => void;
		driver.nextReady = new Promise<DurableOwnerIdentity>((_resolve, reject) => { rejectReady = reject; });
		const firstOpen = registry.acquireRoot({ identity, rootRoute: rootRoute() });
		await Promise.resolve();
		rejectReady(new Error("runner startup error"));
		await assert.rejects(firstOpen, /runner startup error/);
		await assert.rejects(registry.acquireRoot({ identity, rootRoute: rootRoute() }), denied);
		assert.equal(driver.processes.length, 1);
		assert.equal(counts().releaseCount, 0);

		driver.processes[0]!.exit(1);
		await driver.processes[0]!.observedExit;
		await Promise.resolve();
		await Promise.resolve();
		await registry.acquireRoot({ identity, rootRoute: rootRoute() });
		assert.equal(driver.processes.length, 2);
	});

	boundedTest("releases a failed pre-process retain lease and shutdown closes input exactly once", async () => {
		const failed = setup();
		failed.driver.throwOnStart = true;
		await assert.rejects(failed.registry.acquireRoot({ identity, rootRoute: rootRoute() }), /factory failed/);
		assert.deepEqual(failed.counts(), { retainCount: 1, releaseCount: 1, validateCount: 0 });

		const active = setup();
		await active.registry.acquireRoot({ identity, rootRoute: rootRoute() });
		const process = active.driver.processes[0]!;
		const closing = Promise.all([active.registry.shutdown(identity), active.registry.shutdown(identity)]);
		assert.equal(process.closeInputCalls, 1);
		process.exit(0);
		await closing;
		await Promise.resolve();
		assert.equal(active.counts().releaseCount, 1);
	});

	boundedTest("keeps a hanging explicit shutdown fenced and does not count visible views as retention", async () => {
		const { registry, authority, driver, counts } = setup();
		const parent = await registry.acquireRoot({ identity, rootRoute: rootRoute() });
		const route = childRoute("child-hanging-stop");
		const child = await acquireChild(registry, route, registerChild(authority, route));
		parent.release();
		child.release();
		const stopping = registry.shutdown(identity);
		assert.equal(driver.processes[0]!.closeInputCalls, 1);
		await assert.rejects(registry.acquireRoot({ identity, rootRoute: rootRoute() }), denied);
		assert.equal(driver.processes.length, 1);
		assert.equal(counts().releaseCount, 0);
		driver.processes[0]!.exit(0);
		await stopping;
	});

	boundedTest("rechecks identity and root route after joining a pending start", async () => {
		for (const different of [
			{ identity: { ...identity, conversationId: 9 }, route: rootRoute() },
			{ identity, route: rootRoute("different-thread") },
			{ identity, route: { ...rootRoute(), placement: { ...rootPlacement, projectId: "different-project" } } },
		]) {
			const retained = deferred<OwnerRetentionLease>();
			const { registry, driver } = setup({ retain: () => retained.promise });
			const first = registry.acquireRoot({ identity, rootRoute: rootRoute() });
			const conflict = registry.acquireRoot({ identity: different.identity, rootRoute: different.route });
			retained.resolve({ release: () => undefined });
			const outcomes = await Promise.allSettled([first, conflict]);
			assert.equal(outcomes[0]?.status, "fulfilled");
			assert.equal(outcomes[1]?.status, "rejected");
			assert.equal(driver.processes.length, 1);
		}
	});

	boundedTest("re-redeems child credentials after deferred task validation", async () => {
		for (const invalidate of [
			(authority: NativeChildAuthority, credential: string) => authority.revokeCredential(credential),
			(authority: NativeChildAuthority) => authority.advanceGeneration(),
		]) {
			const validation = deferred<boolean>();
			const { registry, authority } = setup({ validateChildTask: () => validation.promise });
			await registry.acquireRoot({ identity, rootRoute: rootRoute() });
			const route = childRoute("child-revoked-during-validation");
			const credential = registerChild(authority, route);
			const joining = acquireChild(registry, route, credential);
			invalidate(authority, credential);
			validation.resolve(true);
			await assert.rejects(joining, denied);
		}
	});

	boundedTest("denies child validation that finishes after owner shutdown and replacement", async () => {
		const validation = deferred<boolean>();
		const { registry, authority, driver } = setup({ validateChildTask: () => validation.promise });
		await registry.acquireRoot({ identity, rootRoute: rootRoute() });
		const route = childRoute("child-owner-replaced");
		const credential = registerChild(authority, route);
		const joining = acquireChild(registry, route, credential);
		const oldProcess = driver.processes[0]!;
		const stopping = registry.shutdown(identity);
		oldProcess.exit(0);
		await stopping;
		await registry.acquireRoot({ identity, rootRoute: rootRoute() });
		validation.resolve(true);
		await assert.rejects(joining, denied);
		assert.equal(driver.processes.length, 2);
	});

	boundedTest("fences pending retention from shutdown and releases it without launching a runner", async () => {
		const retained = deferred<OwnerRetentionLease>();
		let releaseCount = 0;
		const { registry, driver } = setup({ retain: () => retained.promise });
		const acquiring = registry.acquireRoot({ identity, rootRoute: rootRoute() });
		const shuttingDown = registry.shutdown(identity);
		retained.resolve({ release: () => { releaseCount++; } });
		await shuttingDown;
		await assert.rejects(acquiring, denied);
		assert.equal(releaseCount, 1);
		assert.equal(driver.processes.length, 0);
	});

	boundedTest("keeps session admission fenced when late retention release fails", async () => {
		const retained = deferred<OwnerRetentionLease>();
		const { registry, driver } = setup({ retain: () => retained.promise });
		const acquiring = registry.acquireRoot({ identity, rootRoute: rootRoute() });
		const shuttingDown = registry.shutdown(identity);
		retained.resolve({ release: () => Promise.reject(new Error("late retain release failed")) });
		await assert.rejects(shuttingDown, /late retain release failed/);
		await assert.rejects(acquiring, /late retain release failed/);
		await assert.rejects(registry.acquireRoot({ identity, rootRoute: rootRoute() }), /late retain release failed/);
		assert.equal(driver.processes.length, 0);
	});

	boundedTest("permanently seals admission and drains pending retention on dispose", async () => {
		const retained = deferred<OwnerRetentionLease>();
		let releaseCount = 0;
		const { registry, driver } = setup({ retain: () => retained.promise });
		const acquiring = registry.acquireRoot({ identity, rootRoute: rootRoute() });
		const disposing = registry.dispose();
		await assert.rejects(registry.acquireRoot({ identity, rootRoute: rootRoute() }), denied);
		retained.resolve({ release: () => { releaseCount++; } });
		await disposing;
		await assert.rejects(acquiring, denied);
		assert.equal(releaseCount, 1);
		assert.equal(driver.processes.length, 0);
		await registry.dispose();
	});

	boundedTest("awaits asynchronous retention release from shutdown", async () => {
		const release = deferred<void>();
		let releaseCalls = 0;
		const { registry, driver } = setup({ retain: () => ({ release: () => { releaseCalls++; return release.promise; } }) });
		await registry.acquireRoot({ identity, rootRoute: rootRoute() });
		const shuttingDown = registry.shutdown(identity);
		driver.processes[0]!.exit(0);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(releaseCalls, 1);
		let settled = false;
		void shuttingDown.then(() => { settled = true; });
		await Promise.resolve();
		assert.equal(settled, false);
		release.resolve();
		await shuttingDown;
	});

	boundedTest("keeps the session fenced when retention release fails", async () => {
		const release = deferred<void>();
		const { registry, driver } = setup({ retain: () => ({ release: () => release.promise }) });
		await registry.acquireRoot({ identity, rootRoute: rootRoute() });
		const shuttingDown = registry.shutdown(identity);
		driver.processes[0]!.exit(0);
		release.reject(new Error("retain release failed"));
		await assert.rejects(shuttingDown, /retain release failed/);
		await assert.rejects(registry.acquireRoot({ identity, rootRoute: rootRoute() }), denied);
		assert.equal(driver.processes.length, 1);
	});

	boundedTest("cancels acquisition waiting for prior owner release during shutdown and permits later restart", async () => {
		const release = deferred<void>();
		const releaseStarted = deferred<void>();
		let retainCount = 0;
		let releaseCount = 0;
		const { registry, driver } = setup({ retain: () => {
			retainCount++;
			return { release: () => {
				releaseCount++;
				if (retainCount === 1) {
					releaseStarted.resolve();
					return release.promise;
				}
			} };
		} });
		await registry.acquireRoot({ identity, rootRoute: rootRoute() });
		const firstProcess = driver.processes[0]!;
		firstProcess.exit(0);
		await releaseStarted.promise;

		const staleAcquisition = registry.acquireRoot({ identity, rootRoute: rootRoute() });
		const shuttingDown = registry.shutdown(identity);
		release.resolve();
		await shuttingDown;
		await assert.rejects(staleAcquisition, denied);
		assert.equal(releaseCount, 1);
		assert.equal(driver.processes.length, 1);
		assert.equal(firstProcess.closeInputCalls, 0);

		const restarted = await registry.acquireRoot({ identity, rootRoute: rootRoute() });
		assert.equal(restarted.identity.generation, 2);
		assert.equal(driver.processes.length, 2);

		const otherSession = await registry.acquireRoot({
			identity: { durableSessionId: "durable-session-two", conversationId: 5 },
			rootRoute: rootRoute(),
		});
		assert.equal(otherSession.identity.generation, 1);
		assert.equal(driver.processes.length, 3);
	});
});
