import test from "node:test";
import assert from "node:assert/strict";
import { PendingInteractionTracker } from "../src/host/interaction-tracker.ts";
import { ProviderBridge } from "../src/host/bridge.ts";
import { createExtensionUIContext } from "../src/shared/extension-ui-context.ts";

test("ProviderBridge routes JSON-RPC replies to interactionTracker", async () => {
	const sent: string[] = [];
	const bridge = new ProviderBridge((line) => sent.push(line));
	const tracker = bridge.getInteractionTracker();

	const promise = tracker.requestInteraction({
		threadId: "thr_1",
		providerThreadId: "pi_1",
		kind: "select",
		title: "Select an option",
		data: { options: ["A", "B"] },
		scope: "session_1",
	});

	assert.equal(sent.length, 1);
	const sentObj = JSON.parse(sent[0]);
	const reqId = sentObj.id;

	await bridge.handleLine(JSON.stringify({
		jsonrpc: "2.0",
		id: reqId,
		result: { selected: "B" },
	}));

	const res = await promise;
	assert.deepEqual(res, { selected: "B" });
});

test("createExtensionUIContext delegates confirm and select to requestInteraction", async () => {
	let capturedKind = "";
	let capturedPayload: any = null;
	const uiContext = createExtensionUIContext(
		undefined,
		async (kind, payload) => {
			capturedKind = kind;
			capturedPayload = payload;
			if (kind === "confirm") return { confirmed: true };
			if (kind === "select") return { selected: "Option B" };
			return null;
		},
	);

	const confirmed = await uiContext.confirm("Delete?", "Are you sure?");
	assert.equal(capturedKind, "confirm");
	assert.equal(capturedPayload.title, "Delete?");
	assert.equal(confirmed, true);

	const selected = await uiContext.select("Pick one", ["Option A", "Option B"]);
	assert.equal(capturedKind, "select");
	assert.equal(selected, "Option B");
});

test("PendingInteractionTracker formats interaction/request and resolves on reply", async () => {
	const sent: any[] = [];
	const tracker = new PendingInteractionTracker((msg) => sent.push(msg));

	const interactionPromise = tracker.requestInteraction({
		threadId: "thr_1",
		providerThreadId: "pi_1",
		kind: "confirm",
		title: "Delete file?",
		message: "Are you sure?",
		scope: "session_1",
	});

	assert.equal(sent.length, 1);
	assert.equal(sent[0].method, "interaction/request");
	assert.equal(sent[0].params.payload.kind, "confirm");

	const reqId = sent[0].id;
	tracker.handleInteractionResponse({
		jsonrpc: "2.0",
		id: reqId,
		result: { confirmed: true },
	});

	const result = await interactionPromise;
	assert.deepEqual(result, { confirmed: true });
});

test("PendingInteractionTracker handles scope cancellation", async () => {
	const tracker = new PendingInteractionTracker(() => {});
	const interactionPromise = tracker.requestInteraction({
		threadId: "thr_1",
		providerThreadId: "pi_1",
		kind: "input",
		title: "Enter name",
		scope: "session_2",
	});

	tracker.resolvePendingInteractions("session_2", "Cancelled");
	const result = await interactionPromise;
	assert.equal(result, null);
});
