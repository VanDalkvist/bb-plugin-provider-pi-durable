import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, Harness, MemoryStorage, ToolTask } from "@earendil-works/pi-durable";
import { TaskScheduler } from "../node_modules/@earendil-works/pi-durable/dist/harness/scheduler.js";
import { NativeChildDiscoveryObserver } from "../src/runner/native-child-discovery.ts";
import { NativeChildDiscoverySchema } from "../src/native-child-discovery-contract.ts";

describe("read-only native child discovery", () => {
	it("observes intent then exact native submission and restores existing terminal/input children without executing", { timeout: 4000 }, async () => {
		const originalResume = TaskScheduler.prototype.resume;
		let resumes = 0;
		TaskScheduler.prototype.resume = function () { resumes++; };
		const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
		const observed: unknown[] = [];
		const errors: unknown[] = [];
		let observer: NativeChildDiscoveryObserver | undefined;
		try {
			const root = await harness.root(BACKGROUND_CONTEXT);
			observer = new NativeChildDiscoveryObserver(harness, { durableSessionId: "session", parentThreadId: "root-thread", parentConversationId: root.id }, BACKGROUND_CONTEXT,
				async (value) => { observed.push(value); }, (error) => { errors.push(error); });
			const assistant = await root.commit((tx) => tx.appendEntry(AssistantEntry, root.id, {
				model: [{ role: "assistant", content: [{ type: "toolCall", id: "native-call", name: "subagent", arguments: { task: "observe" } }], timestamp: 1 } as unknown as AssistantMessage],
			}), BACKGROUND_CONTEXT);
			const taskId = await root.commit((tx) => tx.createTask(ToolTask, { assistant: assistant.id, callId: "native-call" }, { ownership: { kind: "conversation" } }), BACKGROUND_CONTEXT);
			const childId = await root.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId } })).id, BACKGROUND_CONTEXT);
			await observer.idle();
			assert.deepEqual(errors, []);
			assert.equal(observed.length, 1);
			assert.equal(NativeChildDiscoverySchema.parse(observed[0]).phase, "intent");
			assert.equal(resumes, 0, "discovery does not schedule a native child");
			const child = await harness.conversation(childId, BACKGROUND_CONTEXT);
			assert.ok(child);
			await child.submit({ type: "input", content: "native", requestId: `subagent:${taskId}` }, BACKGROUND_CONTEXT);
			await observer.idle();
			assert.deepEqual(observed.map((item) => NativeChildDiscoverySchema.parse(item).phase), ["intent", "submitted"]);
			assert.equal(resumes, 1, "only the native submit attempted scheduling; fixture intercepted resume");
			const restored = await observer.reconcile();
			assert.deepEqual(restored, [observed[1]]);
			assert.equal(resumes, 1);
			const submission = await harness.commit((tx) => tx.submissionByRequest(childId, `subagent:${taskId}`), BACKGROUND_CONTEXT);
			assert.ok(submission);
			await harness.commit((tx) => tx.settleSubmission(submission.id, { status: "unanswered", reason: "aborted" }), BACKGROUND_CONTEXT);
			await observer.idle();
			assert.deepEqual(await observer.reconcile(), restored, "terminal canceled child remains discoverable without restarting it");
			assert.equal(observed.length, 2, "terminal state does not duplicate the submitted notification");
			const rogueTask = await root.commit((tx) => tx.createTask(ToolTask, { assistant: assistant.id, callId: "not-native" }, { ownership: { kind: "conversation" } }), BACKGROUND_CONTEXT);
			await root.commit(async (tx) => tx.createConversation({ ownership: { kind: "task", taskId: rogueTask } }), BACKGROUND_CONTEXT);
			await observer.idle();
			assert.deepEqual(await observer.reconcile(), restored, "unrelated task is excluded");
			observer.close();
			assert.deepEqual(await observer.reconcile(), []);
		} finally {
			observer?.close();
			await harness.close(BACKGROUND_CONTEXT);
			TaskScheduler.prototype.resume = originalResume;
		}
	});
	it("rejects malformed or credential-bearing signals", () => {
		const value = { parentThreadId: "root", durableSessionId: "session", parentConversationId: 0, childConversationId: 7, taskId: 6, requestId: "subagent:6", phase: "intent" };
		assert.ok(NativeChildDiscoverySchema.safeParse(value).success);
		assert.equal(NativeChildDiscoverySchema.safeParse({ ...value, credential: "private" }).success, false);
		assert.equal(NativeChildDiscoverySchema.safeParse({ ...value, requestId: "subagent:7" }).success, false);
	});
});
