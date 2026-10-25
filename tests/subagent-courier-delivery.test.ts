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

const Subagent = createSubagentExtension(() => ({
	version: 1,
	revision: 0,
	policy: { mode: "inherit" },
}));

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

test("Courier: sleeps 50ms (gather), batches outbox reports, and submits via followUp", async () => {
	const Courier = courierFor();
	let sleptUntil: number | undefined;

	const mockGatherRuntime: any = {
		now: () => 1000,
		sleep: async (time: number) => {
			sleptUntil = time;
		},
		commit: async (fn: any) => fn(),
	};

	// Phase: gather
	await (Courier.definition.phases as any).gather({} as any, mockGatherRuntime, {} as any);
	assert.equal(sleptUntil, 1050, "Courier must sleep 50ms debounce window");

	// Phase: next - packs outbox into sending batch
	const docStore: any = {
		outbox: [
			{ id: "1", name: "agent-a", text: "Report A" },
			{ id: "2", name: "agent-b", text: "Report B" },
		],
		courier: "task_courier_1",
	};

	const nextRuntime: any = {
		conversationId: "conv_parent",
		commit: async (fn: any) => fn({
			doc: async () => docStore,
		}),
	};

	const nextRes = await (Courier.definition.phases as any).next({ id: "task_courier_1" } as any, nextRuntime, {} as any);
	assert.equal(nextRes.status, "running");
	assert.equal(nextRes.checkpoint.phase, "send");
	assert.equal(docStore.batchNumber, 1);
	assert.deepEqual(docStore.outbox, []);
	assert.equal(docStore.sending.requestId, "subagent-batch:task_courier_1:1");
	assert.equal(docStore.sending.reports.length, 2);

	// Phase: send - submits to parent conversation with whenBusy: followUp
	let parentSubmission: any;
	const mockParent = {
		submit: async (req: any) => {
			parentSubmission = req;
			return {
				wait: async () => ({ status: "done" }),
			};
		},
	};

	const sendRuntime: any = {
		conversationId: "conv_parent",
		snapshot: async () => docStore,
		conversation: async () => mockParent,
		commit: async (fn: any) => fn({
			doc: async () => docStore,
		}),
	};

	await (Courier.definition.phases as any).send({ id: "task_courier_1" } as any, sendRuntime, {} as any);
	assert.equal(parentSubmission.type, "input");
	assert.equal(parentSubmission.whenBusy, "followUp");
	assert.equal(parentSubmission.requestId, "subagent-batch:task_courier_1:1");
	assert.equal(
		parentSubmission.content,
		"[Subagent Reports Available]:\n\nReport A\n\n---\n\nReport B",
	);
	assert.equal(docStore.sending, undefined, "sending must be cleared after successful delivery");
});

test("Courier: idempotency retains existing sending batch across retries", async () => {
	const Courier = courierFor();
	const existingSending = {
		requestId: "subagent-batch:task_courier_existing:1",
		reports: [{ id: "1", name: "agent-a", text: "Report A" }],
	};
	const docStore: any = {
		outbox: [{ id: "2", name: "agent-b", text: "Report B" }],
		sending: existingSending,
		batchNumber: 1,
	};

	const nextRuntime: any = {
		conversationId: "conv_parent",
		commit: async (fn: any) => fn({
			doc: async () => docStore,
		}),
	};

	const nextRes = await (Courier.definition.phases as any).next(
		{ id: "task_courier_existing" } as any,
		nextRuntime,
		{} as any,
	);
	assert.equal(nextRes.status, "running");
	assert.equal(nextRes.checkpoint.phase, "send");
	assert.deepEqual(docStore.sending, existingSending, "Existing in-flight sending batch must not be overwritten");
});

test("Courier: sets deliveryHold on admission failure or uncertain outcome", async () => {
	const mockAdmit = async () => {
		throw new Error("Admission rejected by policy");
	};
	const Courier = courierFor(mockAdmit);

	const docStore: any = {
		sending: {
			requestId: "subagent-batch:task_courier_hold:1",
			reports: [{ id: "1", name: "agent-a", text: "Report A" }],
		},
	};

	const mockParent = {
		submit: async () => ({ wait: async () => ({ status: "done" }) }),
	};

	const sendRuntime: any = {
		conversationId: "conv_parent",
		signal: { aborted: false },
		snapshot: async () => docStore,
		conversation: async () => mockParent,
		commit: async (fn: any) => fn({
			doc: async () => docStore,
		}),
	};

	const sendRes = await (Courier.definition.phases as any).send(
		{ id: "task_courier_hold" } as any,
		sendRuntime,
		{ abortSignal: { aborted: false } } as any,
	);

	assert.equal(docStore.deliveryHold?.kind, "admission");
	assert.equal(docStore.deliveryHold?.requestId, "subagent-batch:task_courier_hold:1");
	assert.ok(docStore.deliveryHold?.reason.includes("Admission rejected by policy"));
});


test("Subagent tool: registers record in SubagentsDoc, uses friendly name, and does not double-submit on background execution", async () => {
	const tool = Subagent.tools[0];
	const docStore: any = { agents: {} };
	let createdTasks: any[] = [];
	let childConversationSubmitted = false;

	const mockApi: any = {
		taskId: "task_parent_exec",
		conversationId: "conv_parent_exec",
		agent: async () => ({ model: { provider: "test-prov", modelId: "test-mod" }, thinkingLevel: "off" }),
		models: { getAvailable: async () => [] },
		commit: async (fn: any) => {
			const mockTx: any = {
				scanConversations: async () => ({ items: [] }),
				createConversation: async () => ({ id: "conv_child_live" }),
				doc: async () => docStore,
				createTask: async (def: any, input: any, ownership: any) => {
					createdTasks.push({ def, input, ownership });
					return "task_reporter_gen";
				},
			};
			return fn(mockTx);
		},
		details: async () => {},
		conversation: async () => {
			childConversationSubmitted = true;
			return {
				submit: async () => ({
					wait: async () => ({ status: "done", type: "input", answer: "a1" }),
				}),
			};
		},
	};

	const res = await tool.execute(
		{ task: "Background integration job", background: true },
		mockApi,
		{} as any,
	);

	assert.ok(res.output[0].text.includes("Subagent spawned in background"));
	assert.equal(childConversationSubmitted, false, "Must NOT call api.conversation or child.submit in background mode");
	assert.equal(createdTasks.length, 1);
	assert.equal(createdTasks[0].input.task, "Background integration job");
	assert.equal(createdTasks[0].input.conversationId, "conv_child_live");
	assert.equal(docStore.agents["subagent:task_parent_exec"].reporter, "task_reporter_gen");
	assert.equal(docStore.agents["subagent:task_parent_exec"].task, "Background integration job");
	assert.equal(
		docStore.agents["subagent:task_parent_exec"].name,
		"Background integration job · worker",
		"Subagent record name must use nativeChildTitle friendly name",
	);
});

test("Subagent tool: foreground execution directly submits and waits for child completion", async () => {
	const tool = Subagent.tools[0];
	const docStore: any = { agents: {} };
	let submitCalled = false;
	let waitCalled = false;

	const mockApi: any = {
		taskId: "task_parent_sync",
		conversationId: "conv_parent_sync",
		agent: async () => ({ model: { provider: "test-prov", modelId: "test-mod" }, thinkingLevel: "off" }),
		models: { getAvailable: async () => [] },
		commit: async (fn: any) => {
			const mockTx: any = {
				scanConversations: async () => ({ items: [] }),
				createConversation: async () => ({ id: "conv_child_sync" }),
				doc: async () => docStore,
				entry: async () => ({
					model: [{ role: "assistant", content: [{ type: "text", text: "Sync result OK" }] }],
				}),
			};
			return fn(mockTx);
		},
		details: async () => {},
		conversation: async () => ({
			submit: async (req: any) => {
				submitCalled = true;
				assert.equal(req.content, "Run synchronous computation");
				return {
					wait: async () => {
						waitCalled = true;
						return { status: "done", type: "input", answer: "ans_sync" };
					},
				};
			},
		}),
	};

	const res = await tool.execute(
		{ task: "Run synchronous computation", background: false },
		mockApi,
		{} as any,
	);

	assert.equal(submitCalled, true, "Foreground subagent must call handle.submit");
	assert.equal(waitCalled, true, "Foreground subagent must wait for completion");
	assert.equal(res.output[0].text, "Sync result OK");
	assert.equal(docStore.agents["subagent:task_parent_sync"].settled, true);
	assert.equal(docStore.agents["subagent:task_parent_sync"].report, "Sync result OK");
});
