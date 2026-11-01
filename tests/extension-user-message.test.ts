import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionActions } from "../src/runner/extension-bridge.ts";

test("ExtensionActions.sendUserMessage: delegates to onSubmitUserMessage in FSM", async () => {
	let submittedContent = "";
	let submittedBehavior: "steer" | "followUp" | undefined;

	const actions = createExtensionActions({
		onSubmitUserMessage: async (content, deliverAs) => {
			submittedContent = content;
			submittedBehavior = deliverAs;
		},
		sessionManager: { appendCustomEntry: () => {} } as any,
	});

	// Verify sendUserMessage delegates properly
	actions.sendUserMessage("Please run task X", { deliverAs: "followUp" });
	assert.equal(submittedContent, "Please run task X");
	assert.equal(submittedBehavior, "followUp");

	// Verify sendMessage with triggerTurn delegates
	submittedContent = "";
	actions.sendMessage({ customType: "custom", content: "Message with trigger" }, { triggerTurn: true });
	assert.equal(submittedContent, "Message with trigger");
});
