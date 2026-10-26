import test from "node:test";
import assert from "node:assert/strict";
import { SubagentsDoc } from "../src/runner/subagent-docs.ts";
import {
	Anchor,
	BACKGROUND,
	courierFor,
	reporterFor,
} from "../src/runner/subagent-delivery.ts";
import { createSubagentExtension } from "../src/runner/subagent.ts";
import { Subagent } from "./fixtures/subagent-courier-delivery-support.ts";

test("SubagentsDoc: defines initial state with empty agents", () => {
	const initial = SubagentsDoc.definition.initial();
	assert.deepEqual(initial, { agents: {} });
	assert.equal(SubagentsDoc.definition.kind, "bb.subagents");
	assert.equal(SubagentsDoc.definition.version, 1);
	assert.equal(SubagentsDoc.definition.scope, "conversation");
});

test("Anchor: terminates with completed outcome and handles abort", async () => {
	assert.equal(Anchor.definition.name, "bb.subagent-anchor");
	let committed: any;
	const mockRuntime: any = {
		commit: async (fn: any) => {
			committed = await fn();
			return committed;
		},
	};
	const resDone = await (Anchor.definition.phases as any).done({} as any, mockRuntime, {} as any);
	assert.deepEqual(resDone, { status: "terminal", outcome: { status: "completed", result: null } });

	const resAbort = await (Anchor.definition as any).abort({} as any, mockRuntime, {} as any);
	assert.deepEqual(resAbort, { status: "terminal", outcome: { status: "aborted" } });
});

test("Reporter: delivers task to child, formats response, and queues to outbox", async () => {
	const mockCourier = courierFor();
	const Reporter = reporterFor(mockCourier);

	const taskInput = {
		key: "subagent:task_1",
		conversationId: "conv_child_1" as any,
		task: "Verify security patches",
		requestId: "subagent:task_1",
	};

	const docStore: any = {
		agents: {
			"subagent:task_1": {
				name: "Verify security patches · worker",
				conversationId: "conv_child_1",
				requestId: "subagent:task_1",
				task: "Verify security patches",
				role: "worker",
				ownerTaskId: "task_1",
				background: true,
			},
		},
	};

	let submitCalledWith: any;
	const mockChild = {
		submit: async (req: any) => {
			submitCalledWith = req;
			return {
				wait: async () => ({
					status: "done",
					type: "input",
					answer: "ans_entry_1",
				}),
			};
		},
	};

	const mockDeliverTx: any = {
		doc: async () => docStore,
		entry: async (_ctor: any, id: string) => {
			if (id === "ans_entry_1") {
				return {
					model: [{ role: "assistant", content: [{ type: "text", text: "Patches verified OK" }] }],
				};
			}
			return undefined;
		},
	};

	const deliverRuntime: any = {
		conversationId: "conv_parent",
		conversation: async (id: string) => (id === "conv_child_1" ? mockChild : undefined),
		commit: async (fn: any) => fn(mockDeliverTx),
	};

	// 1. Deliver phase
	const deliverRes = await (Reporter.definition.phases as any).deliver(
		{ input: taskInput } as any,
		deliverRuntime,
		{} as any,
	);
	assert.equal(deliverRes.status, "running");
	assert.equal(deliverRes.checkpoint.phase, "report");
	assert.equal(deliverRes.checkpoint.text, "Subagent Verify security patches · worker answered: Patches verified OK");
	assert.equal(docStore.agents["subagent:task_1"].settled, true);
	assert.equal(submitCalledWith.content, "Verify security patches");

	// 2. Report phase: pushes to outbox and creates Courier task
	let createdCourierTask = false;
	const mockReportTx: any = {
		doc: async () => docStore,
		task: async () => undefined,
		createTask: async (_def: any, _inp: any, ownership: any) => {
			assert.deepEqual(ownership, BACKGROUND);
			createdCourierTask = true;
			return "task_courier_99";
		},
	};

	const reportRuntime: any = {
		conversationId: "conv_parent",
		commit: async (fn: any) => fn(mockReportTx),
	};

	const reportRes = await (Reporter.definition.phases as any).report(
		{
			id: "task_reporter_42",
			input: taskInput,
			state: { checkpoint: deliverRes.checkpoint },
		} as any,
		reportRuntime,
		{} as any,
	);

	assert.equal(reportRes.status, "terminal");
	assert.equal(reportRes.outcome.status, "completed");
	assert.equal(docStore.outbox.length, 1);
	assert.equal(docStore.outbox[0].id, "task_reporter_42");
	assert.equal(docStore.outbox[0].text, "Subagent Verify security patches · worker answered: Patches verified OK");
	assert.equal(createdCourierTask, true);
	assert.equal(docStore.courier, "task_courier_99");
});
