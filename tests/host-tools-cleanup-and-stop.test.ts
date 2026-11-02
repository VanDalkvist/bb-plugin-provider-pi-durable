import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderBridge } from "../src/host/bridge.ts";
import { PendingToolCallTracker } from "../src/host/tool-call-tracker.ts";
import { PendingInteractionTracker } from "../src/host/interaction-tracker.ts";
import { RunnerProcess } from "../src/host/runner-process.ts";

test("thread/stop and thread/discard cancel pending tool calls and interactions", { timeout: 3000 }, async () => {
	const sent: string[] = [];
	const bridge = new ProviderBridge((line) => sent.push(line));
	const toolTracker = bridge.getToolCallTracker();
	const interactionTracker = bridge.getInteractionTracker();

	// Start a pending tool call
	const toolPromise = toolTracker.forwardToolCall({
		threadId: "thr_cancel_test",
		providerThreadId: "pi_1",
		toolName: "check_ui",
		arguments: {},
		scope: "thr_cancel_test",
	});

	// Start a pending interaction
	const interactionPromise = interactionTracker.requestInteraction({
		threadId: "thr_cancel_test",
		providerThreadId: "pi_1",
		kind: "confirm",
		title: "Confirm?",
		scope: "thr_cancel_test",
	});

	// Trigger thread/stop via bridge
	await bridge.handleLine(JSON.stringify({
		jsonrpc: "2.0",
		id: 99,
		method: "thread/stop",
		params: { threadId: "thr_cancel_test", intent: "release" },
	}));

	const toolResult = await toolPromise;
	assert.equal(toolResult.isError, true);
	assert.ok(toolResult.content[0].text.includes("Thread stopped"));

	const interactionResult = await interactionPromise;
	assert.equal(interactionResult, null);
});

test("RunnerProcess.cleanup deletes temporary tools file", { timeout: 3000 }, async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-tools-"));
	const toolsFile = path.join(tempDir, "pi-tools-test.json");
	fs.writeFileSync(toolsFile, JSON.stringify([{ name: "test_tool" }]), "utf8");

	assert.ok(fs.existsSync(toolsFile));

	const runner = new RunnerProcess({
		cwd: tempDir,
		args: [],
		toolsFilePath: toolsFile,
	});

	runner.cleanup();
	assert.equal(fs.existsSync(toolsFile), false, "tools file must be deleted on cleanup");

	runner.kill();
	fs.rmSync(tempDir, { recursive: true, force: true });
});
