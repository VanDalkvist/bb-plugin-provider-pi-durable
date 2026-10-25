import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import {
	extractCodemodeTitle,
	getCodemodePresentation,
} from "../src/host/tool-presentations.ts";
import {
	buildToolItemShape,
	translateToolStart,
	translateToolEnd,
} from "../src/host/tool-delta-translator.ts";

describe("Codemode Presentation Parity (Cycle 103)", () => {
	it("extractCodemodeTitle: extracts title from comments, handles options header, and falls back cleanly", () => {
		assert.equal(
			extractCodemodeTitle("// Check Mihomo VPN config\nconst res = await tools.bash(...)"),
			"Check Mihomo VPN config",
		);

		assert.equal(
			extractCodemodeTitle(
				'// @options: {"max_output_tokens": 10000}\n// Run thread health audit\nawait tools.bash(...)',
			),
			"Run thread health audit",
		);

		assert.equal(
			extractCodemodeTitle("/* Inspect service daemon */\nconst list = await tools.bash(...)"),
			"Inspect service daemon",
		);

		assert.equal(
			extractCodemodeTitle("const status = await tools.bash({ command: 'git status' });"),
			"const status = await tools.bash({ command: 'git status' });",
		);

		const longLine = "// " + "A".repeat(100);
		const title5 = extractCodemodeTitle(longLine);
		assert.equal(title5.length, 80);
		assert.ok(title5.endsWith("..."));

		assert.equal(extractCodemodeTitle(""), "Code execution");
		assert.equal(extractCodemodeTitle("   \n\n  "), "Code execution");
		assert.equal(extractCodemodeTitle(undefined), "Code execution");
		assert.equal(extractCodemodeTitle(null), "Code execution");
	});

	it("getCodemodePresentation: produces BB-compliant Code glyph and label pair", () => {
		const pres = getCodemodePresentation({
			code: "// Verify process health\nawait tools.bash({ command: 'ps aux' })",
		});
		assert.deepEqual(pres.label, { pending: "Running code", completed: "Ran code" });
		assert.deepEqual(pres.icon, { glyph: "Code" });
		assert.equal(pres.title, "Verify process health");
	});

	it("translateToolStart: codemode renders as tool item with Code presentation and no delegation copy", () => {
		const event = {
			type: "tool_execution_start" as const,
			toolCallId: "call_code_1",
			toolName: "codemode",
			args: {
				code: "// Check service status\nconst res = await tools.bash({ command: 'pm2 status' });",
			},
		};

		const { shape, delta } = translateToolStart(event, "/tmp");

		assert.equal(shape.type, "tool");
		assert.equal(shape.tool, "codemode");
		assert.equal(shape.server, "pi");

		assert.equal(delta.kind, "item.open");
		assert.equal(delta.item?.type, "tool");
		assert.equal(delta.key.parentRef, undefined);
		assert.equal((delta.item as Record<string, unknown>).parentToolCallId, undefined);

		const pres = delta.presentation as Record<string, unknown>;
		assert.ok(pres, "Codemode delta must include presentation metadata");
		assert.deepEqual(pres.icon, { glyph: "Code" });
		assert.deepEqual(pres.label, { pending: "Running code", completed: "Ran code" });
		assert.equal(pres.title, "Check service status");

		const parsed = threadDeltaSchema.safeParse(delta);
		assert.ok(parsed.success, `Delta must conform to BB schema: ${JSON.stringify(parsed)}`);
	});

	it("translateToolEnd: codemode closes cleanly with Code presentation and completed status", () => {
		const cachedShape = buildToolItemShape(
			"codemode",
			{ code: "// Inspect logs\nawait tools.bash({ command: 'tail -n 20' })" },
			"/tmp",
		);

		const endEvent = {
			type: "tool_execution_end" as const,
			toolCallId: "call_code_1",
			toolName: "codemode",
			result: "Script completed\nWall time 2.1s\nOutput:\nOK",
			isError: false,
		};

		const delta = translateToolEnd(endEvent, cachedShape, "/tmp");

		assert.equal(delta.kind, "item.close");
		assert.equal(delta.status, "completed");
		assert.equal(delta.item?.type, "tool");
		assert.equal(delta.key.parentRef, undefined);
		assert.equal((delta.item as Record<string, unknown>).parentToolCallId, undefined);

		const pres = delta.presentation as Record<string, unknown>;
		assert.ok(pres);
		assert.deepEqual(pres.icon, { glyph: "Code" });
		assert.equal(pres.title, "Inspect logs");

		const parsed = threadDeltaSchema.safeParse(delta);
		assert.ok(parsed.success, `Delta must conform to BB schema: ${JSON.stringify(parsed)}`);
	});
});
