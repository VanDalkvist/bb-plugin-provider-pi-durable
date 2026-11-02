import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBbDynamicToolsExtension } from "../src/runner/extensions/bb-tools-extension.ts";
import { createForwardToolCall, createRequestInteraction, dispatchBridgeInboundFrame } from "../src/runner/bridge-channel.ts";
import { PendingToolCallTracker } from "../src/host/tool-call-tracker.ts";
import { PendingInteractionTracker } from "../src/host/interaction-tracker.ts";
import { createExtensionUIContext } from "../src/shared/extension-ui-context.ts";
import { RunnerProcess } from "../src/host/runner-process.ts";

test("E2E IPC: bb-tools-extension executes tool call through host ToolCallTracker and receives result", { timeout: 5000 }, async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-bb-tools-"));
	const toolsFile = path.join(tempDir, "tools.json");
	fs.writeFileSync(toolsFile, JSON.stringify([
		{
			name: "check_ui",
			description: "Validates a UI specification",
			inputSchema: {
				type: "object",
				properties: { spec: { type: "string" } },
				required: ["spec"],
			},
		},
	]), "utf8");

	const hostSentToDaemon: Array<Record<string, unknown>> = [];
	const toolCallTracker = new PendingToolCallTracker((msg) => {
		hostSentToDaemon.push(msg);
	});

	// Mock runner bridge sender: writes to host handler
	const runnerSentToHost: Array<Record<string, unknown>> = [];
	const sendToBridge = (msg: unknown) => {
		runnerSentToHost.push(msg as Record<string, unknown>);
	};

	const forwardToolCall = createForwardToolCall(sendToBridge);
	const ext = createBbDynamicToolsExtension({
		toolsFilePath: toolsFile,
		forwardToolCall,
	});

	assert.ok(ext.tools.has("check_ui"));
	const tool = ext.tools.get("check_ui")!;

	// 1. Tool execution starts in runner
	const executionPromise = tool.execute("call_e2e_1", { spec: "Button('Submit')" }, undefined);

	// Verify runner sent tool_call_request to host
	assert.equal(runnerSentToHost.length, 1);
	const toolReq = runnerSentToHost[0];
	assert.equal(toolReq.kind, "tool_call_request");
	assert.equal(toolReq.toolName, "check_ui");
	assert.deepEqual(toolReq.arguments, { spec: "Button('Submit')" });

	// 2. Host processes tool_call_request and forwards to daemon via tracker
	const hostCallPromise = toolCallTracker.forwardToolCall({
		threadId: "thr_e2e",
		providerThreadId: "pi_e2e",
		toolName: toolReq.toolName as string,
		arguments: toolReq.arguments,
		scope: "thr_e2e",
	});

	// Verify host sent item/tool/call to BB daemon
	assert.equal(hostSentToDaemon.length, 1);
	const daemonMsg = hostSentToDaemon[0];
	assert.equal(daemonMsg.method, "item/tool/call");
	assert.equal((daemonMsg.params as any).tool, "check_ui");

	// 3. Mock BB daemon answers with success result
	toolCallTracker.handleToolCallResponse({
		id: daemonMsg.id as number,
		result: {
			contentItems: [{ type: "inputText", text: "UI spec verified: 0 errors." }],
			isError: false,
		},
	});

	const hostForwardResult = await hostCallPromise;
	assert.equal(hostForwardResult.isError, false);
	assert.equal(hostForwardResult.content[0].text, "UI spec verified: 0 errors.");

	// 4. Host sends tool_call_response frame back to runner
	dispatchBridgeInboundFrame({
		kind: "tool_call_response",
		callId: toolReq.callId,
		result: hostForwardResult.content,
		isError: hostForwardResult.isError,
	});

	// 5. Runner resolves tool execution
	const toolResult = await executionPromise;
	assert.equal(toolResult.isError, false);
	assert.equal(toolResult.content[0].text, "UI spec verified: 0 errors.");

	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("E2E IPC: Extension UI interaction executes through host InteractionTracker and receives reply", { timeout: 5000 }, async () => {
	const hostSentToDaemon: Array<Record<string, unknown>> = [];
	const interactionTracker = new PendingInteractionTracker((msg) => {
		hostSentToDaemon.push(msg);
	});

	const runnerSentToHost: Array<Record<string, unknown>> = [];
	const sendToBridge = (msg: unknown) => {
		runnerSentToHost.push(msg as Record<string, unknown>);
	};

	const requestInteraction = createRequestInteraction(sendToBridge);
	const uiContext = createExtensionUIContext(undefined, requestInteraction);

	// 1. Extension calls confirm dialog
	const confirmPromise = uiContext.confirm("Deploy to Prod?", "Proceed with deployment?");

	assert.equal(runnerSentToHost.length, 1);
	const intReq = runnerSentToHost[0];
	assert.equal(intReq.kind, "interaction_request");
	assert.equal(intReq.dialogKind, "confirm");
	assert.equal(intReq.title, "Deploy to Prod?");

	// 2. Host forwards to daemon
	const hostInteractionPromise = interactionTracker.requestInteraction({
		threadId: "thr_e2e_int",
		providerThreadId: "pi_e2e",
		kind: (intReq.dialogKind ?? "confirm") as any,
		title: intReq.title as string,
		message: intReq.message as string,
		scope: "thr_e2e_int",
	});

	assert.equal(hostSentToDaemon.length, 1);
	const daemonMsg = hostSentToDaemon[0];
	assert.equal(daemonMsg.method, "interaction/request");

	// 3. Daemon responds with confirmed: true
	interactionTracker.handleInteractionResponse({
		id: daemonMsg.id as number,
		result: { confirmed: true },
	});

	const hostResult = await hostInteractionPromise;
	assert.deepEqual(hostResult, { confirmed: true });

	// 4. Host sends interaction_response back to runner
	dispatchBridgeInboundFrame({
		kind: "interaction_response",
		id: intReq.id,
		result: hostResult,
	});

	// 5. Runner resolves confirm dialog
	const confirmed = await confirmPromise;
	assert.equal(confirmed, true);
});

test("E2E IPC: Real RunnerProcess stdio pipe round-trip for tool_call_request and response", { timeout: 5000 }, async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-ipc-e2e-"));
	const workerScript = path.join(tempDir, "runner-worker.mjs");

	// Child worker script reads tools file, sends tool_call_request on FD 3, and listens for response on FD 4
	fs.writeFileSync(workerScript, `
import { Socket } from "node:net";
import fs from "node:fs";

// 1. Announce ready on stdout
process.stdout.write(JSON.stringify({ type: "ready", kind: "ready" }) + "\\n");

// 2. Write tool_call_request to FD 3
const req = { kind: "tool_call_request", callId: "c_test_99", toolName: "check_ui", arguments: { spec: "Header()" } };
fs.writeSync(3, Buffer.from(JSON.stringify(req) + "\\n"));

// 3. Listen on FD 4 for tool_call_response
const inSocket = new Socket({ fd: 4, readable: true, writable: false });
let buf = "";
inSocket.on("data", (chunk) => {
	buf += chunk.toString("utf8");
	if (buf.includes("\\n")) {
		const line = buf.trim();
		const parsed = JSON.parse(line);
		if (parsed.kind === "tool_call_response" && parsed.callId === "c_test_99") {
			// Success: write output file and exit
			fs.writeFileSync(process.argv[2], JSON.stringify(parsed.result));
			process.exit(0);
		}
	}
});
`, "utf8");

	let runner: RunnerProcess | undefined;
	const prev = process.env.PI_DURABLE_RUNNER_PATH;
	process.env.PI_DURABLE_RUNNER_PATH = workerScript;

	try {
		const outputFile = path.join(tempDir, "output.json");
		let receivedToolCallRequest: any = null;

		let exitResolve: () => void;
		const exitPromise = new Promise<void>((resolve) => {
			exitResolve = resolve;
		});

		runner = new RunnerProcess({
			cwd: tempDir,
			args: [outputFile],
			onExit: () => {
				exitResolve();
			},
			onChannelMessage: (msg) => {
				if (msg.kind === "tool_call_request") {
					receivedToolCallRequest = msg;
					// Host sends response back to runner over FD 4
					runner?.sendChannel({
						kind: "tool_call_response",
						callId: msg.callId,
						result: [{ type: "text", text: "Real IPC verified!" }],
						isError: false,
					});
				}
			},
		});

		// Wait for child to exit cleanly
		await Promise.race([
			exitPromise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("IPC pipe round-trip timed out")), 4000)),
		]);

		assert.ok(receivedToolCallRequest, "Host must have received tool_call_request over FD 3");
		assert.equal(receivedToolCallRequest.toolName, "check_ui");

		assert.ok(fs.existsSync(outputFile), "Runner must have written output file");
		const completedOutput = JSON.parse(fs.readFileSync(outputFile, "utf8"));
		assert.equal(completedOutput[0].text, "Real IPC verified!");
	} finally {
		runner?.kill();
		if (prev === undefined) delete process.env.PI_DURABLE_RUNNER_PATH;
		else process.env.PI_DURABLE_RUNNER_PATH = prev;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
