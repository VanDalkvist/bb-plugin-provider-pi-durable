import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PromptInput } from "@earendil-works/pi-durable";
import { parseCliArgs, createPiPrompt } from "durable-zero/core";

const args = parseCliArgs(process.argv.slice(2));
const extension = createPiPrompt(SettingsManager.inMemory(), process.cwd(), {
	systemPromptPath: args.systemPromptPath,
	appendSystemPromptPath: args.appendSystemPromptPath,
});
const input = { conversationId: "fixture", agent: { cwd: process.cwd(), tools: [] } } as unknown as PromptInput;
const rendered = Object.fromEntries((extension.sections ?? []).map((section) => [
	section.key, section.render(input, {} as never),
]));
console.log(JSON.stringify({ type: "ready", kind: "ready", ready: true }));
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const cmd = JSON.parse(line);
	console.log(JSON.stringify({
		type: "response", id: cmd.id, command: cmd.type, success: true,
		data: cmd.type === "inspect" ? { args, rendered } : {},
	}));
});
lines.on("close", () => process.exit(0));
