import test from "node:test";
import assert from "node:assert/strict";
import {
	bbDynamicToolSchema,
	bbToolCallRequestParamsSchema,
	bbToolCallResponseSchema,
	bbInteractionRequestParamsSchema,
} from "../src/host/bb-tools.ts";

test("bbDynamicToolSchema validates valid BB dynamic tool definition", () => {
	const valid = {
		name: "check_ui",
		description: "Checks a ```ui block before putting it in reply",
		inputSchema: {
			type: "object",
			properties: { spec: { type: "string" } },
			required: ["spec"],
		},
		presentation: { label: { pending: "Checking UI", completed: "Checked UI" }, suppress: true },
	};
	const parsed = bbDynamicToolSchema.safeParse(valid);
	assert.equal(parsed.success, true);
	if (parsed.success) {
		assert.equal(parsed.data.name, "check_ui");
	}
});

test("bbToolCallRequestParamsSchema parses item/tool/call params", () => {
	const payload = {
		threadId: "thr_123",
		providerThreadId: "pi_durable_179348",
		turnId: null,
		callId: "call-1",
		tool: "check_ui",
		arguments: { spec: "Card('Title', [])" },
	};
	const parsed = bbToolCallRequestParamsSchema.safeParse(payload);
	assert.equal(parsed.success, true);
});

test("bbToolCallResponseSchema extracts text content items and error flags", () => {
	const okRes = {
		contentItems: [{ type: "inputText", text: "No errors." }],
	};
	const parsed = bbToolCallResponseSchema.safeParse(okRes);
	assert.equal(parsed.success, true);
});
