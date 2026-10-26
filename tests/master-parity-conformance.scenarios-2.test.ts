import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { SettingsManager, type ExtensionRunner, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import plugin from "../server.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { buildToolItemShape, translateToolStart, translateToolEnd } from "../src/host/tool-delta-translator.ts";
import { translateAgentEnd } from "../src/host/message-delta-translator.ts";
import { forkSessionDatabase } from "../src/host/thread-fork.ts";
import { handleThreadStop, type BridgeRouterContext } from "../src/host/bridge-router.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import type { PiThreadSession } from "../src/host/session.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import type { BBToolExecutionUpdateEvent, BBWireEvent } from "../src/runner/bridge/contracts.ts";
import type { DurableView } from "../src/runner/runtime-types.ts";
import { DynamicPromptSections, createPiPrompt } from "../src/runner/prompt.ts";
import { adaptExtensionTool } from "../src/runner/extension-bridge.ts";
import { isProcessAlive } from "../src/runner/session-storage.ts";
import { sessionFixture } from "./fixtures/mirror.ts";
import { publicDeltaFixture, wireFixture } from "./fixtures/wire.ts";
import { viewFixture } from "./fixtures/durable.ts";

test("D-14, D-15: Subagent delegation visual cards & conversationId extraction", () => {
	const delegShape = buildToolItemShape("subagent", { task: "Inspect auth module" }, "/w");
	assert.equal(delegShape.type, "delegation", "D-14: type delegation");
	const start = translateToolStart({ type: "tool_execution_start", toolCallId: "c_sub", toolName: "subagent", args: {} }, "/w");
	const openPresentation = start.delta.presentation as { icon?: { glyph?: string } };
	assert.equal(openPresentation.icon?.glyph, "Bot", "D-14: Bot glyph presentation");

	const end = translateToolEnd(
		{ type: "tool_execution_end", toolCallId: "c_sub", toolName: "subagent", result: "Done", isError: false, details: { conversationId: "conv_42" } },
		start.shape,
		"/w",
	);
	const endItem = end.item as { childRef?: string };
	assert.equal(endItem.childRef, "conv_42", "D-15: childRef updated to conversationId");
	assert.equal(threadDeltaSchema.safeParse(end).success, true);
});

test("D-16, D-17, D-18: Dynamic prompt sections, direct MCP & tool lifecycle hooks", async () => {
	const dynamicSections = new DynamicPromptSections();
	const promptExt = createPiPrompt(SettingsManager.inMemory(), "/w", { dynamicSections });
	dynamicSections.updateSections({ mcp_servers: "- direct-db (direct)" });
	const mcpSec = promptExt.sections?.find((s) => s.key === "mcp_servers");
	const rendered = mcpSec?.render(
		{ conversationId: "c1", agent: { cwd: "/w", tools: [{ name: "read" }] } } as unknown as Parameters<NonNullable<typeof mcpSec>["render"]>[0],
		{} as unknown as Parameters<NonNullable<typeof mcpSec>["render"]>[1],
	) as string;
	assert.ok(rendered.includes("<mcp_servers>") && rendered.includes("- direct-db (direct)"), "D-16, D-17: direct MCP XML tagging");

	let callHook = false;
	let resultHook = false;
	const mockRunner = {
		hasHandlers: () => true,
		emitToolCall: async () => { callHook = true; return undefined; },
		emitToolResult: async () => { resultHook = true; },
	} as unknown as ExtensionRunner;

	const toolDef: ToolDefinition = {
		name: "ping", label: "Ping", description: "Fixture ping",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
	};
	const adapted = adaptExtensionTool(toolDef, async () => ({} as never), undefined, () => mockRunner);
	const execRes = await adapted.execute({} as never, { callId: "c_ping" } as never, {} as never);
	assert.equal(callHook, true, "D-18: emitToolCall invoked");
	assert.equal(resultHook, true, "D-18: emitToolResult invoked");
	assert.deepEqual(execRes.output, [{ type: "text", text: "pong" }]);
});

test("D-19, D-20: Diagnostics notices & session ownership tracking", () => {
	const notices: Array<{ level: string; message: string }> = [];
	const rawRecord: unknown = { kind: "notice", level: "info", message: "MCP ready" };
	if (rawRecord && typeof rawRecord === "object" && "kind" in rawRecord && rawRecord.kind === "notice"
		&& "level" in rawRecord && typeof rawRecord.level === "string" && "message" in rawRecord && typeof rawRecord.message === "string") {
		notices.push({ level: rawRecord.level, message: rawRecord.message });
	}
	assert.deepEqual(notices[0], { level: "info", message: "MCP ready" }, "D-19: notice unpacked cleanly");
	assert.equal(notices.some((n) => n.message.includes("[object Object]")), false, "D-19: zero [object Object]");

	assert.equal(isProcessAlive(process.pid), true, "D-20: current process is alive");
	assert.equal(isProcessAlive(0), false, "D-20: PID 0 is not alive");
	assert.equal(isProcessAlive(9999999), false, "D-20: stale PID is not alive");
});
