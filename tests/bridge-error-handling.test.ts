import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderBridge } from "../src/host/bridge.ts";

test("ProviderBridge returns -32700 Parse error on malformed JSON without throwing", async () => {
	const sent: string[] = [];
	const bridge = new ProviderBridge((json) => {
		sent.push(json);
	});

	await bridge.handleLine("this is not valid json");

	assert.equal(sent.length, 1);
	const response = JSON.parse(sent[0]);
	assert.equal(response.error.code, -32700);
	assert.ok(response.error.message.includes("Parse error"));
});

test("ProviderBridge handles empty and whitespace lines as no-op", async () => {
	const sent: string[] = [];
	const bridge = new ProviderBridge((json) => {
		sent.push(json);
	});

	await bridge.handleLine("");
	await bridge.handleLine("   \n\t  ");

	assert.equal(sent.length, 0);
});

test("ProviderBridge returns error when steering without active session", async () => {
	const sent: string[] = [];
	const bridge = new ProviderBridge((json) => {
		sent.push(json);
	});

	await bridge.handleLine(JSON.stringify({
		id: "steer_1",
		method: "turn/steer",
		params: {
			threadId: "thr_nonexistent",
			clientRequestId: "creq_test123456",
			input: [{ type: "text", text: "steer message" }],
		},
	}));

	assert.equal(sent.length, 1);
	const response = JSON.parse(sent[0]);
	assert.equal(response.id, "steer_1");
	assert.equal(response.error.code, -32000);
	assert.ok(response.error.message.includes("No active session"));
});
