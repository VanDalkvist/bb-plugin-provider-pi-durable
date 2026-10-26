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

test("Courier: sleeps 50ms (gather), batches outbox reports, and submits via followUp", async () => {
	const Courier = courierFor();
	let sleptUntil: number | undefined;
	let sleepCheckpoint: unknown;

	const mockGatherRuntime: any = {
		now: () => 1000,
		sleepUntil: async (time: number, checkpoint: unknown) => {
			sleptUntil = time;
			sleepCheckpoint = checkpoint;
		},
		commit: async (fn: any) => fn(),
	};

	// Phase: gather
	await (Courier.definition.phases as any).gather({} as any, mockGatherRuntime, {} as any);
	assert.equal(sleptUntil, 1050, "Courier must durably sleep for the 50ms debounce window");
	assert.deepEqual(sleepCheckpoint, { phase: "next" });

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
