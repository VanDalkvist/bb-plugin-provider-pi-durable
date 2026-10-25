import test from "node:test";
import assert from "node:assert/strict";
import * as contracts from "../src/contracts/runner-command.ts";

test("command contract validates actual image/conversation/model and policy envelope", () => {
	assert.equal(typeof contracts.runnerCommandSchema, "object");
	const schema = contracts.runnerCommandSchema;
	assert.equal(schema.safeParse({ type: "prompt", id: "req_1", message: "x", images: [{ type: "image", data: "AA==", mimeType: "image/png" }], conversationId: "2", future: true }).success, true);
	assert.equal(schema.safeParse({ type: "set_subagent_policy", policyRecord: { revision: 1 } }).success, true);
	assert.equal(schema.safeParse({ type: "set_thinking_level", level: "high" }).success, true);
	assert.equal(schema.safeParse({ type: "prompt", images: ["invalid"] }).success, false);
	assert.equal(schema.safeParse({ type: "prompt", conversationId: "foreign-id" }).success, false);
	assert.equal(schema.safeParse({ type: "set_thinking_level", level: 42 }).success, false);
	assert.equal(schema.safeParse({ type: "prompt", id: {} }).success, false);
});
