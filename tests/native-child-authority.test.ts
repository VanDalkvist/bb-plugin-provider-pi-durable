import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineTask, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { NativeChildAuthority } from "../src/host/native-child-authority.ts";
import type { NativeChildRoute, NativePlacement, OrdinaryRootPlacement, OrdinaryRootRoute, RedemptionIdentity } from "../src/native-child-contract.ts";

let durableConversationId: ConversationId;
let durableTaskId: TaskId;
let harness: Awaited<ReturnType<typeof Harness.open>>;

before(async () => {
	const models = createModels();
	harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
	const root = await harness.root(BACKGROUND_CONTEXT);
	durableConversationId = root.id;
	const testTask = defineTask({
		name: "native-child-authority-test-id",
		version: 1,
		initial: (): { phase: "idle" } => ({ phase: "idle" }),
		phases: { idle: async () => undefined },
		abort: async () => undefined,
	});
	durableTaskId = await root.commit(
		(tx) => tx.createTask(testTask, {}, { ownership: { kind: "conversation" } }),
		BACKGROUND_CONTEXT,
	);
});

after(async () => {
	await harness.close(BACKGROUND_CONTEXT);
});

const placement: NativePlacement = {
	parentThreadId: "parent-thread",
	projectId: "project-1",
	environmentId: "environment-1",
	hostId: "host-1",
	providerId: "pi-durable",
};

const rootPlacement: OrdinaryRootPlacement = { ...placement, parentThreadId: null };

function rootRoute(): OrdinaryRootRoute {
	return { kind: "ordinary-root", threadId: "root-thread", providerThreadId: "root-provider-thread", placement: rootPlacement };
}

function childRoute(): NativeChildRoute {
	return {
		kind: "native-child",
		threadId: "child-thread",
		providerThreadId: "child-provider-thread",
		placement,
		child: {
			durableSessionId: "durable-session-1",
			taskId: durableTaskId,
			conversationId: durableConversationId,
			requestId: "subagent:task-1",
		},
		bootstrapRequestId: "bootstrap:task-1",
	};
}

function identity(route: OrdinaryRootRoute | NativeChildRoute): RedemptionIdentity {
	if (route.kind === "ordinary-root") {
		return {
			kind: route.kind,
			threadId: route.threadId,
			providerThreadId: route.providerThreadId,
			placement: route.placement,
		};
	}
	return {
		kind: route.kind,
		threadId: route.threadId,
		providerThreadId: route.providerThreadId,
		placement: route.placement,
		child: {
			durableSessionId: route.child.durableSessionId,
			taskId: route.child.taskId,
			conversationId: route.child.conversationId,
			requestId: route.child.requestId,
		},
		bootstrapRequestId: route.bootstrapRequestId,
	};
}

function expectDenied(action: () => unknown, credential?: string): void {
	assert.throws(action, (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(error.message, "Native child authorization denied");
		if (credential !== undefined) assert.equal(error.message.includes(credential), false);
		return true;
	});
}

describe("Native child authority: ID compatibility fixtures, not verified task provenance", () => {
	it("redeems registered ordinary-root and native-child routes from host state", () => {
		const authority = new NativeChildAuthority();
		const root = rootRoute();
		const child = childRoute();
		authority.registerRoot(root);
		authority.registerNativeChild(child);
		const rootGrant = authority.issue(root);
		const childGrant = authority.issue(child);
		assert.deepEqual(authority.redeem({ credential: rootGrant.credential, expected: identity(root) }), root);
		assert.deepEqual(authority.redeem({ credential: childGrant.credential, expected: identity(child) }), child);
	});

	it("rejects absent, malformed, unknown, tampered, expired, and invalid-clock credentials", () => {
		let now = 10_000;
		const authority = new NativeChildAuthority({ now: () => now });
		const route = childRoute();
		authority.registerNativeChild(route);
		const grant = authority.issue(route, 100);
		expectDenied(() => authority.redeem({ credential: undefined, expected: identity(route) }));
		expectDenied(() => authority.redeem({ credential: { token: grant.credential }, expected: identity(route) }));
		const tampered = `${grant.credential.startsWith("A") ? "B" : "A"}${grant.credential.slice(1)}`;
		expectDenied(() => authority.redeem({ credential: tampered, expected: identity(route) }), grant.credential);
		expectDenied(() => authority.redeem({ credential: `${"A".repeat(42)}A`, expected: identity(route) }));
		assert.deepEqual(authority.redeem({ credential: grant.credential, expected: identity(route) }), route);
		now = 10_100;
		expectDenied(() => authority.redeem({ credential: grant.credential, expected: identity(route) }), grant.credential);
		now = 10_050;
		expectDenied(() => authority.redeem({ credential: grant.credential, expected: identity(route) }), grant.credential);
		now = Number.NaN;
		expectDenied(() => authority.redeem({ credential: grant.credential, expected: identity(route) }), grant.credential);
		now = Number.POSITIVE_INFINITY;
		expectDenied(() => authority.redeem({ credential: grant.credential, expected: identity(route) }), grant.credential);
		now = 10_100;
		expectDenied(() => authority.redeem({ credential: grant.credential, expected: identity(route) }), grant.credential);
	});

	it("keeps root null-parent placement valid while rejecting it for native children", () => {
		const authority = new NativeChildAuthority();
		const root = rootRoute();
		const child = childRoute();
		authority.registerRoot(root);
		authority.registerNativeChild(child);
		const rootGrant = authority.issue(root);
		assert.deepEqual(authority.redeem({ credential: rootGrant.credential, expected: identity(root) }), root);
		const nullParentChild = {
			...identity(child),
			placement: { ...child.placement, parentThreadId: null },
		};
		expectDenied(() => authority.redeem({ credential: authority.issue(child).credential, expected: nullParentChild }));
	});

	it("uses distinct exact route keys for NUL-containing identity pairs", () => {
		const authority = new NativeChildAuthority();
		const first: OrdinaryRootRoute = {
			...rootRoute(),
			threadId: "a\u0000b",
			providerThreadId: "c",
		};
		const second: OrdinaryRootRoute = {
			...rootRoute(),
			threadId: "a",
			providerThreadId: "b\u0000c",
		};
		authority.registerRoot(first);
		authority.registerRoot(second);
		const firstGrant = authority.issue(first);
		const secondGrant = authority.issue(second);
		assert.deepEqual(authority.redeem({ credential: firstGrant.credential, expected: identity(first) }), first);
		assert.deepEqual(authority.redeem({ credential: secondGrant.credential, expected: identity(second) }), second);
	});

	it("rejects any cross-thread, session, task, conversation, request, placement, or provider identity", () => {
		const authority = new NativeChildAuthority();
		const route = childRoute();
		authority.registerNativeChild(route);
		const grant = authority.issue(route);
		const variants: Array<(value: RedemptionIdentity) => void> = [
			(value) => { value.threadId = "other-thread"; },
			(value) => { value.providerThreadId = "other-provider-thread"; },
			(value) => { if (value.kind === "native-child") value.child.durableSessionId = "other-session"; },
			(value) => { if (value.kind === "native-child") value.child.taskId += 1; },
			(value) => { if (value.kind === "native-child") value.child.conversationId += 1; },
			(value) => { if (value.kind === "native-child") value.child.requestId = "other-request"; },
			(value) => { value.placement.parentThreadId = "other-parent"; },
			(value) => { value.placement.projectId = "other-project"; },
			(value) => { value.placement.environmentId = "other-environment"; },
			(value) => { value.placement.hostId = "other-host"; },
			(value) => { if (value.kind === "native-child") value.bootstrapRequestId = "other-bootstrap"; },
		];
		for (const change of variants) {
			const expected = structuredClone(identity(route));
			change(expected);
			expectDenied(() => authority.redeem({ credential: grant.credential, expected }), grant.credential);
		}
		expectDenied(() => authority.redeem({
			credential: grant.credential,
			expected: { ...identity(route), placement: { ...route.placement, providerId: "other-provider" } },
		}), grant.credential);
		expectDenied(() => authority.redeem({ credential: grant.credential, expected: { ...identity(route), metadata: { credential: grant.credential } } }), grant.credential);
	});

	it("fences grants on owner-generation replacement and explicit revocation", () => {
		const authority = new NativeChildAuthority();
		const route = childRoute();
		authority.registerNativeChild(route);
		const revokedGrant = authority.issue(route);
		authority.revokeCredential(revokedGrant.credential);
		expectDenied(() => authority.redeem({ credential: revokedGrant.credential, expected: identity(route) }), revokedGrant.credential);
		const oldGenerationGrant = authority.issue(route);
		authority.advanceGeneration();
		expectDenied(() => authority.redeem({ credential: oldGenerationGrant.credential, expected: identity(route) }), oldGenerationGrant.credential);
		expectDenied(() => authority.issue(route));
		authority.registerNativeChild(route);
		assert.deepEqual(authority.redeem({ credential: authority.issue(route).credential, expected: identity(route) }), route);
	});

	it("treats identical registration as idempotent and rejects contradictory rebinds", () => {
		const authority = new NativeChildAuthority();
		const route = childRoute();
		authority.registerNativeChild(route);
		authority.registerNativeChild(structuredClone(route));
		const grant = authority.issue(route);
		const contradictory = { ...structuredClone(route), placement: { ...route.placement, projectId: "replacement-project" } };
		expectDenied(() => authority.registerNativeChild(contradictory), grant.credential);
		assert.deepEqual(authority.redeem({ credential: grant.credential, expected: identity(route) }), route);
	});

	it("allows only the exact preauthorized bootstrap control and denies ordinary follow-ups", () => {
		const authority = new NativeChildAuthority();
		const route = childRoute();
		authority.registerNativeChild(route);
		const grant = authority.issue(route);
		assert.deepEqual(authority.validateBootstrapControl({
			credential: grant.credential,
			expected: identity(route),
			control: { type: "native-child-bootstrap", requestId: "bootstrap:task-1" },
		}), route);
		expectDenied(() => authority.validateBootstrapControl({
			credential: grant.credential,
			expected: identity(route),
			control: { type: "native-child-bootstrap", requestId: "follow-up:task-1" },
		}), grant.credential);
		expectDenied(() => authority.validateBootstrapControl({
			credential: grant.credential,
			expected: identity(route),
			control: { type: "native-child-bootstrap", requestId: "bootstrap:task-1", prompt: "run another task" },
		}), grant.credential);
		expectDenied(() => authority.validateBootstrapControl({
			credential: grant.credential,
			expected: { ...identity(route), kind: "ordinary-root" },
			control: { type: "native-child-bootstrap", requestId: "bootstrap:task-1" },
		}), grant.credential);
	});

	it("fails closed for unknown routes and authority shutdown", () => {
		const authority = new NativeChildAuthority();
		const route = rootRoute();
		expectDenied(() => authority.issue(route));
		authority.registerRoot(route);
		const grant = authority.issue(route);
		authority.revokeAll();
		expectDenied(() => authority.redeem({ credential: grant.credential, expected: identity(route) }), grant.credential);
	});
});
