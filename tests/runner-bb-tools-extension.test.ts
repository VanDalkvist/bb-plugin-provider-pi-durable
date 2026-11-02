import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBbDynamicToolsExtension } from "../src/runner/extensions/bb-tools-extension.ts";

test("createBbDynamicToolsExtension registers tools from toolsFilePath", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tools-test-"));
	const toolsFile = path.join(tempDir, "tools.json");
	fs.writeFileSync(toolsFile, JSON.stringify([
		{
			name: "check_ui",
			description: "Checks a ```ui block",
			inputSchema: {
				type: "object",
				properties: { spec: { type: "string" } },
				required: ["spec"],
			},
		},
	]), "utf8");

	let forwardedName = "";
	let forwardedArgs: any = null;
	const ext = createBbDynamicToolsExtension({
		toolsFilePath: toolsFile,
		forwardToolCall: async (name, args) => {
			forwardedName = name;
			forwardedArgs = args;
			return { content: [{ type: "text", text: "OK" }], isError: false };
		},
	});

	assert.ok(ext.tools.has("check_ui"), "check_ui must be registered in extension tools Map");
	const tool = ext.tools.get("check_ui")!;
	assert.equal(tool.name, "check_ui");
	assert.deepEqual(tool.definition.namespace, { name: "bb", description: "Beyond Boundaries dynamic tools" });
	assert.deepEqual((tool as any).namespace, { name: "bb", description: "Beyond Boundaries dynamic tools" });

	const res = await tool.execute("call_1", { spec: "Card('Title', [])" } as any, undefined as any);
	assert.equal(forwardedName, "check_ui");
	assert.deepEqual(forwardedArgs, { spec: "Card('Title', [])" });
	assert.equal((res as any).content[0].text, "OK");

	fs.rmSync(tempDir, { recursive: true, force: true });
});
