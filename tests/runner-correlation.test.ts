import test from "node:test";
import assert from "node:assert/strict";
import { RunnerRpcChannel } from "../src/host/runner-rpc-channel.ts";

function request(channel: RunnerRpcChannel) {
	let id = "";
	const pending = channel.createRequest({ type: "get_state" }, 100, (payload) => {
		assert.equal(typeof payload.id, "string");
		id = String(payload.id);
	});
	return { pending, id };
}

function response(channel: RunnerRpcChannel, payload: unknown): void {
	channel.feedStdout(Buffer.from(`${JSON.stringify(payload)}\n`), () => assert.fail("response forwarded as work event"));
}

test("IPC response retains actual success/data envelope and settles exact request", async () => {
	const channel = new RunnerRpcChannel();
	const { pending, id } = request(channel);
	response(channel, { id, type: "response", command: "get_state", success: true, data: { model: null }, additive: true });
	assert.deepEqual(await pending, { model: null });
	assert.equal(channel.pendingRequests.size, 0);
});

test("IPC wrong command cannot resolve a request with matching id", async () => {
	const channel = new RunnerRpcChannel();
	const { pending, id } = request(channel);
	const rejected = assert.rejects(pending, /MISMATCHED_RESPONSE/);
	assert.throws(() => response(channel, { id, type: "response", command: "abort", success: true, data: {} }), /MISMATCHED_RESPONSE/);
	await rejected;
});

test("IPC malformed response fails explicitly, never resolves its arbitrary data", async () => {
	const channel = new RunnerRpcChannel();
	const { pending, id } = request(channel);
	const rejected = assert.rejects(pending, /INVALID_MESSAGE/);
	assert.throws(() => response(channel, { id, type: "response", command: "get_state", success: "yes", data: {} }), /INVALID_MESSAGE/);
	await rejected;
});

test("IPC valid failure rejects while late and unsolicited replies are consumed", async () => {
	const channel = new RunnerRpcChannel();
	const { pending, id } = request(channel);
	const rejected = assert.rejects(pending, /Missing model/);
	response(channel, { id, type: "response", command: "get_state", success: false, error: "Missing model" });
	await rejected;
	response(channel, { id, type: "response", command: "get_state", success: true });
	response(channel, { id: "req_999", type: "response", command: "get_state", success: true });
	assert.equal(channel.pendingRequests.size, 0);
});
