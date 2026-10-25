import test from "node:test";
import assert from "node:assert/strict";
import { RunnerRpcChannel } from "../src/host/runner-rpc-channel.ts";

function feed(channel: RunnerRpcChannel, value: unknown, events: unknown[]): void {
	channel.feedStdout(Buffer.from(`${JSON.stringify(value)}\n`), (event) => events.push(event));
}

test("IPC accepts additive known events and split UTF8 text", () => {
	const channel = new RunnerRpcChannel();
	const events: unknown[] = [];
	const value = { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ёж" }, extra: true };
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
	const split = bytes.indexOf(Buffer.from("ё")) + 1;
	channel.feedStdout(bytes.subarray(0, split), (event) => events.push(event));
	channel.feedStdout(bytes.subarray(split), (event) => events.push(event));
	assert.deepEqual(events, [value]);
});

test("IPC unknown event is skipped, not dispatched as native work", () => {
	const channel = new RunnerRpcChannel();
	const events: unknown[] = [];
	feed(channel, { type: "future_event", extra: true }, events);
	assert.deepEqual(events, []);
	feed(channel, { type: "agent_start" }, events);
	assert.deepEqual(events, [{ type: "agent_start" }]);
});

test("IPC malformed known event explicitly rejects pending transport without parent/child boundary", async () => {
	const channel = new RunnerRpcChannel();
	const events: unknown[] = [];
	const pending = channel.createRequest({ type: "get_state" }, 100, () => {});
	const rejection = assert.rejects(pending, /INVALID_MESSAGE/);
	assert.throws(() => feed(channel, { type: "tool_execution_start", toolName: 33, conversationId: "12" }, events), /INVALID_MESSAGE/);
	await rejection;
	assert.deepEqual(events, []);
	assert.equal(channel.pendingRequests.size, 0);
});

test("IPC broken JSON rejects pending RPC rather than waiting for timeout", async () => {
	const channel = new RunnerRpcChannel();
	const pending = channel.createRequest({ type: "get_state" }, 100, () => {});
	const rejection = assert.rejects(pending, /MALFORMED_JSON/);
	assert.throws(() => channel.feedStdout(Buffer.from("{broken\n"), () => assert.fail("invalid event dispatched")), /MALFORMED_JSON/);
	await rejection;
	assert.equal(channel.pendingRequests.size, 0);
});

test("FD3 ready and model scope stay valid; malformed known frame is explicit", () => {
	const channel = new RunnerRpcChannel();
	const frames: unknown[] = [];
	channel.feedChannel(Buffer.from('{"kind":"ready","ready":true}\n'), (value) => frames.push(value));
	channel.feedChannel(Buffer.from('{"kind":"model-scope","scopedModelIds":["p/m"]}\n'), (value) => frames.push(value));
	assert.equal(frames.length, 2);
	assert.throws(() => channel.feedChannel(Buffer.from('{"kind":"ready","ready":"wrong"}\n'), () => {}), /INVALID_MESSAGE/);
});
