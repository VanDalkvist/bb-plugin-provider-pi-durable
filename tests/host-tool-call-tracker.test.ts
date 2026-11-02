import test from "node:test";
import assert from "node:assert/strict";
import { PendingToolCallTracker } from "../src/host/tool-call-tracker.ts";
import { ProviderBridge } from "../src/host/bridge.ts";

test("ProviderBridge routes JSON-RPC replies to toolCallTracker", async () => {
	const sent: string[] = [];
	const bridge = new ProviderBridge((line) => sent.push(line));
	const tracker = bridge.getToolCallTracker();

	const callPromise = tracker.forwardToolCall({
		threadId: "thr_1",
		providerThreadId: "pi_1",
		toolName: "check_ui",
		arguments: {},
		scope: "session_1",
	});

	assert.equal(sent.length, 1);
	const sentObj = JSON.parse(sent[0]);
	const reqId = sentObj.id;

	await bridge.handleLine(JSON.stringify({
		jsonrpc: "2.0",
		id: reqId,
		result: {
			contentItems: [{ type: "inputText", text: "OK" }],
		},
	}));

	const res = await callPromise;
	assert.equal(res.isError, false);
	assert.equal(res.content[0].text, "OK");
});

test("PendingToolCallTracker sends item/tool/call and resolves on reply", async () => {
	const sentMessages: any[] = [];
	const tracker = new PendingToolCallTracker((msg) => sentMessages.push(msg));

	const callPromise = tracker.forwardToolCall({
		threadId: "thr_1",
		providerThreadId: "pi_1",
		toolName: "check_ui",
		arguments: { spec: "Card('Test', [])" },
		scope: "session_1",
	});

	assert.equal(sentMessages.length, 1);
	assert.equal(sentMessages[0].method, "item/tool/call");
	assert.equal(sentMessages[0].params.tool, "check_ui");

	const reqId = sentMessages[0].id;
	const handled = tracker.handleToolCallResponse({
		jsonrpc: "2.0",
		id: reqId,
		result: {
			contentItems: [{ type: "inputText", text: "No errors." }],
		},
	});
	assert.equal(handled, true);

	const res = await callPromise;
	assert.equal(res.isError, false);
	assert.deepEqual(res.content, [{ type: "text", text: "No errors." }]);
});

test("PendingToolCallTracker handles error response and scope cancellation", async () => {
	const tracker = new PendingToolCallTracker(() => {});
	const callPromise = tracker.forwardToolCall({
		threadId: "thr_1",
		providerThreadId: "pi_1",
		toolName: "broken_tool",
		arguments: {},
		scope: "session_2",
	});

	tracker.resolvePendingToolCalls("session_2", "Session aborted");
	const res = await callPromise;
	assert.equal(res.isError, true);
	assert.ok(res.content[0].text.includes("Session aborted"));
});
