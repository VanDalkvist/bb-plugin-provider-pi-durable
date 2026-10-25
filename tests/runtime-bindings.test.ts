import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeBindings } from "../src/runner/runtime-bindings.ts";
import { nativeRuntimeState, trackedBinding } from "./fixtures/runtime-state.ts";
import type { DurableView } from "../src/runner/runtime-types.ts";

test("initial subscription failure releases the newly acquired view", async () => {
 const native = await nativeRuntimeState();
 try {
  const bad = trackedBinding(native.conversation, true);
  assert.throws(() => new RuntimeBindings(native.root, bad.binding, () => {}), /SUBSCRIBE_FAILED/);
  assert.equal(bad.counts().disposals, 1);
 } finally { await native.close(); }
});

test("conversation replacement disposes old binding and ignores stale callbacks", async () => {
	const native = await nativeRuntimeState();
	try {
		const first = trackedBinding(native.conversation), second = trackedBinding(native.conversation);
		const updates: Partial<DurableView>[] = [];
		const owner = new RuntimeBindings(native.root, first.binding, (patch) => updates.push(patch));
		owner.bindConversation(native.child, second.binding);
		assert.equal(owner.current, native.child);
		assert.deepEqual(first.counts(), { subscriptions: 1, disposals: 1, unsubscribes: 1 });
		const before = updates.length;
		first.emitStale(native.conversation);
		assert.equal(updates.length, before);
		second.emit(native.conversation);
		assert.equal(updates.length, before + 1);
		owner.close(); owner.close();
		assert.deepEqual(second.counts(), { subscriptions: 1, disposals: 1, unsubscribes: 1 });
		second.emitStale(native.conversation);
		assert.equal(updates.length, before + 1);
	} finally { await native.close(); }
});

test("failed new subscription preserves the previous active conversation", async () => {
	const native = await nativeRuntimeState();
	try {
		const first = trackedBinding(native.conversation), bad = trackedBinding(native.conversation, true);
		const updates: Partial<DurableView>[] = [];
		const owner = new RuntimeBindings(native.root, first.binding, (patch) => updates.push(patch));
		assert.throws(() => owner.bindConversation(native.child, bad.binding), /SUBSCRIBE_FAILED/);
		assert.equal(owner.current, native.root);
		assert.equal(first.counts().disposals, 0);
		assert.equal(bad.counts().disposals, 1);
		first.emit(native.conversation);
		assert.equal(updates.length, 1);
		owner.close();
	} finally { await native.close(); }
});

test("task binding is not double subscribed, closes once and suppresses late updates", async () => {
	const native = await nativeRuntimeState();
	try {
		const conversation = trackedBinding(native.conversation), tasks = trackedBinding(native.tasks);
		const updates: Partial<DurableView>[] = [];
		const owner = new RuntimeBindings(native.root, conversation.binding, (patch) => updates.push(patch));
		owner.attachTasks(tasks.binding); owner.attachTasks(tasks.binding);
		assert.equal(owner.tasksOpen, true);
		assert.equal(tasks.counts().subscriptions, 1);
		owner.closeTasks(); owner.closeTasks();
		assert.equal(owner.tasksOpen, false);
		assert.equal(tasks.counts().disposals, 1);
		const before = updates.length;
		tasks.emitStale(native.tasks);
		assert.equal(updates.length, before);
		owner.close();
		const late = trackedBinding(native.tasks);
		assert.throws(() => owner.attachTasks(late.binding), /BINDING_CLOSED/);
		assert.equal(late.counts().disposals, 1);
	} finally { await native.close(); }
});
