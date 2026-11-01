import test from "node:test";
import assert from "node:assert/strict";
import { createDurableController } from "../src/runner/runtime-controller.ts";
import { SubagentsDoc } from "../src/runner/subagent-docs.ts";

test("createDurableController: abort() performs cascading abort with { background: true } across all subagents", async () => {
	const abortedConversations: Array<{ id: any; options?: any }> = [];

	const child1 = {
		id: 2,
		abort: async (_ctx: any, options?: any) => {
			abortedConversations.push({ id: 2, options });
		},
	};
	const child2 = {
		id: 3,
		abort: async (_ctx: any, options?: any) => {
			abortedConversations.push({ id: 3, options });
		},
	};

	const docStore: any = {
		agents: {
			"subagent:worker_1": {
				name: "Worker 1",
				conversationId: 2,
				settled: false,
			},
			"subagent:worker_2": {
				name: "Worker 2",
				conversationId: 3,
				settled: false,
			},
			"subagent:worker_finished": {
				name: "Worker Finished",
				conversationId: 4,
				settled: true, // already settled, should not be aborted
			},
		},
	};

	const mockCurrent: any = {
		id: 1,
		abort: async (_ctx: any, options?: any) => {
			abortedConversations.push({ id: 1, options });
		},
		commit: async (fn: any) => {
			const tx: any = {
				doc: async (docDef: any) => {
					if (docDef === SubagentsDoc) return docStore;
					return {};
				},
			};
			return fn(tx);
		},
	};

	const mockOpened: any = {
		conversation: async (id: any) => {
			if (id === 2) return child1;
			if (id === 3) return child2;
			return undefined;
		},
	};

	const mockModelRuntime: any = {
		getModel: () => undefined,
	};

	const controller = createDurableController({
		bindings: { current: mockCurrent } as any,
		opened: mockOpened,
		modelRuntime: mockModelRuntime,
		getState: () => ({ conversation: {} } as any),
		notice: () => {},
		fail: (err) => { throw err; },
		setActiveModelRef: () => {},
	});

	await controller.abort();

	// 1. Root conversation must receive abort with background: true
	const rootAbort = abortedConversations.find((c) => c.id === 1);
	assert.ok(rootAbort, "Root conversation must be aborted");
	assert.deepEqual(rootAbort.options, { background: true }, "Root abort must cross background boundaries");

	// 2. Unsettled child subagents must receive cascading abort with background: true
	const child1Abort = abortedConversations.find((c) => c.id === 2);
	assert.ok(child1Abort, "Active child 1 must be aborted");
	assert.deepEqual(child1Abort.options, { background: true });

	const child2Abort = abortedConversations.find((c) => c.id === 3);
	assert.ok(child2Abort, "Active child 2 must be aborted");
	assert.deepEqual(child2Abort.options, { background: true });

	// 3. Settled subagents must not be re-aborted
	const childFinishedAbort = abortedConversations.find((c) => c.id === 4);
	assert.equal(childFinishedAbort, undefined, "Settled subagent must not be called");
});
