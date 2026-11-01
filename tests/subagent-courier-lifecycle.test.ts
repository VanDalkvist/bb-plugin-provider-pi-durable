import test from "node:test";
import assert from "node:assert/strict";
import { courierFor, clearDeliveryHold } from "../src/runner/subagent-courier.ts";

test("Courier: recovers from uncertain delivery via hold watchdog instead of deadlocking", async () => {
	const courier = courierFor(undefined, 50);
	const docStore: any = {
		outbox: [{ id: "report_1", text: "Finished task 1" }],
	};

	let submitCount = 0;
	const mockParent = {
		submit: async () => {
			submitCount++;
			return {
				wait: async () => ({
					status: submitCount === 1 ? "interrupted" : "done",
					type: "input",
				}),
			};
		},
	};

	const mockRuntime: any = {
		conversationId: "conv_root",
		now: () => Date.now(),
		sleepUntil: async (_time: number, next: any) => ({ status: "running", checkpoint: next }),
		snapshot: async () => docStore,
		conversation: async () => mockParent,
		commit: async (fn: any) => {
			const tx: any = {
				doc: async () => docStore,
			};
			return fn(tx);
		},
		signal: { aborted: false },
		watchDoc: async () => {
			let onUpdate: any;
			return {
				value: docStore,
				start: (fn: any) => { onUpdate = fn; },
				stop: async () => {},
				closed: new Promise(() => {}), // never closes on its own
			};
		},
	};

	// 1. next phase: batches outbox into sending
	const resNext1 = await (courier.definition.phases as any).next(
		{ id: "courier_1" } as any,
		mockRuntime,
		{ abortSignal: undefined } as any,
	);
	assert.equal(resNext1.status, "running");
	assert.equal(resNext1.checkpoint.phase, "send");
	assert.ok(docStore.sending);

	// 2. send phase: parent returns status: "interrupted"
	const resSend1 = await (courier.definition.phases as any).send(
		{ id: "courier_1" } as any,
		mockRuntime,
		{ abortSignal: undefined } as any,
	);
	assert.equal(resSend1.status, "running");
	assert.equal(resSend1.checkpoint.phase, "hold");
	assert.ok(docStore.deliveryHold, "deliveryHold must be set upon uncertain outcome");

	// 3. hold phase: watchdog must resolve and clear deliveryHold, transitioning to "next"
	const resHold = await (courier.definition.phases as any).hold(
		{ id: "courier_1" } as any,
		mockRuntime,
		{ abortSignal: undefined } as any,
	);
	assert.equal(resHold.status, "running");
	assert.equal(resHold.checkpoint.phase, "next");
	assert.equal(docStore.deliveryHold, undefined, "Watchdog must clear deliveryHold so courier does not deadlock");

	// 4. next phase: after hold recovery, courier can re-send or process outbox
	const resNext2 = await (courier.definition.phases as any).next(
		{ id: "courier_1" } as any,
		mockRuntime,
		{ abortSignal: undefined } as any,
	);
	assert.equal(resNext2.status, "running");
	assert.equal(resNext2.checkpoint.phase, "send");
});

test("clearDeliveryHold: explicitly removes hold from document", () => {
	const doc: any = {
		deliveryHold: { kind: "uncertain", reason: "testing" },
	};
	clearDeliveryHold(doc);
	assert.equal(doc.deliveryHold, undefined);
});
