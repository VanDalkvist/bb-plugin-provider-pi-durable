import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	Harness,
	MemoryStorage,
	createRegistry,
	watchEvents,
	type AgentEvent,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { captureNativeToolEnds } from "./native-tool-events.fixture.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";

test("Slice 4: Harness native events project to schema-valid BB deltas", async () => {
	const { leafEnd, badleafEnd, batchEnd } = await captureNativeToolEnds();
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));

	adapter.handleEvent({ type: "tool_execution_start", toolCallId: leafEnd.toolCallId, toolName: "leaf", args: {} } as any, null as any);
	adapter.handleEvent(leafEnd as any, null as any);
	adapter.handleEvent({ type: "tool_execution_start", toolCallId: badleafEnd.toolCallId, toolName: "badleaf", args: {} } as any, null as any);
	adapter.handleEvent(badleafEnd as any, null as any);
	adapter.handleEvent({ type: "tool_execution_start", toolCallId: batchEnd.toolCallId, toolName: "subagent", args: { task: "sub task" } } as any, null as any);
	adapter.handleEvent(batchEnd as any, null as any);

	const translator = new DeltaTranslator();
	const deltaCtx = { threadId: "thr_test", cwd: "/test" };

	for (const wire of emitted) {
		const deltas = translator.translate(wire, deltaCtx);
		for (const delta of deltas) {
			assert.ok(threadDeltaSchema.safeParse(delta).success);
		}
	}

	const leafWire = emitted.find((e) => e.type === "tool_execution_end" && e.toolCallId === leafEnd.toolCallId) as any;
	assert.equal(leafWire.isError, false);
	assert.ok(leafWire.details?.diff);

	const badleafWire = emitted.find((e) => e.type === "tool_execution_end" && e.toolCallId === badleafEnd.toolCallId) as any;
	assert.equal(badleafWire.isError, true);
	assert.match(badleafWire.result, /native failure/);

	const batchWire = emitted.find((e) => e.type === "tool_execution_end" && e.toolCallId === batchEnd.toolCallId) as any;
	assert.equal(batchWire.isError, false);
	assert.equal(batchWire.details?.conversationId, 77);
});

test("Slice 4: Real Harness + CodemodeSandbox full matrix (write, edit, bash success/fail, caught read)", async () => {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codemode-matrix-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);

	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));

	const script = `
		await tools.write({ path: "app.txt", content: "old text\\nline 2\\n" });
		const editRes = await tools.edit({ path: "app.txt", edits: [{ oldText: "old text", newText: "new text" }] });
		const bOk = await tools.bash({ command: "echo hello-bash" });
		let bErr = null;
		try { await tools.bash({ command: "exit 42" }); } catch (e) { bErr = e.message; }
		let rErr = null;
		try { await tools.read({ path: "missing.txt" }); } catch (e) { rErr = e.message; }
		return { editRes, bOk, bErr, rErr };
	`;

	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("codemode", { code: script }, { id: "cm-matrix" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);

	const harness = await Harness.open(new MemoryStorage(), {
		models,
		registry,
		env: () => new NodeExecutionEnv({ cwd: tmpDir }),
	}, ctx);

	const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const emittedWire: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emittedWire.push(evt));

	const stream = await watchEvents(harness, root.id, ctx);
	stream.start(async (batch: readonly AgentEvent[]) => {
		for (const event of batch) adapter.handleEvent(event, null as any);
	});

	try {
		await (await root.submit({ type: "input", content: "run" }, ctx)).wait(ctx);
		await harness.waitForIdle(ctx);
	} finally {
		await stream.stop();
		await harness.close(ctx);
		await fs.rm(tmpDir, { recursive: true, force: true });
	}

	const translator = new DeltaTranslator();
	const deltaCtx = { threadId: "thr_codemode", cwd: tmpDir };

	for (const wire of emittedWire) {
		const deltas = translator.translate(wire, deltaCtx);
		for (const delta of deltas) {
			assert.ok(threadDeltaSchema.safeParse(delta).success);
		}
	}

	const ends = emittedWire.filter((e) => e.type === "tool_execution_end") as any[];
	const writeEnd = ends.find((e) => e.toolName === "write");
	const editEnd = ends.find((e) => e.toolName === "edit");
	const bashEnds = ends.filter((e) => e.toolName === "bash");
	const readEnd = ends.find((e) => e.toolName === "read");
	const codemodeEnd = ends.find((e) => e.toolName === "codemode");

	assert.equal(writeEnd.isError, false);
	assert.equal(editEnd.isError, false);
	assert.ok(editEnd.details?.diff, "Edit tool must carry diff details");
	assert.equal(bashEnds[0].isError, false);
	assert.match(bashEnds[0].result, /hello-bash/);
	assert.equal(bashEnds[1].isError, true, "Exit 42 bash tool must have isError: true");
	assert.equal(readEnd.isError, true, "Missing file read tool must have isError: true");
	assert.equal(codemodeEnd.isError, false, "Parent codemode must complete with isError: false");
});

test("Slice 4: Structured generic MCP-style tool output conforms to BB delta schema", () => {
	const translator = new DeltaTranslator();
	const deltaCtx = { threadId: "thr_mcp", cwd: "/test" };

	const startDeltas = translator.translate({
		type: "tool_execution_start",
		toolCallId: "call_mcp_1",
		toolName: "mcp__github__get_issue",
		args: { issue_number: 42 },
	}, deltaCtx);
	assert.equal(startDeltas.length, 1);
	assert.ok(threadDeltaSchema.safeParse(startDeltas[0]).success);

	const endDeltas = translator.translate({
		type: "tool_execution_end",
		toolCallId: "call_mcp_1",
		toolName: "mcp__github__get_issue",
		result: JSON.stringify({ id: 42, title: "Fix tool parity", state: "open" }),
		isError: false,
	}, deltaCtx);
	assert.equal(endDeltas.length, 1);
	const closeDelta = endDeltas[0];
	assert.equal(closeDelta.status, "completed");
	assert.ok(threadDeltaSchema.safeParse(closeDelta).success);
});
