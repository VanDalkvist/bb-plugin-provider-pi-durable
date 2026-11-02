import { readFileSync, existsSync } from "node:fs";
import { forwardHostToolCall } from "durable-zero/core";
import { bbDynamicToolSchema } from "../host/bb-tools.ts";

export default function bbToolsExtension(pi: any): void {
	const toolsPath = process.env.PI_BB_TOOLS_FILE;
	if (!toolsPath || !existsSync(toolsPath)) return;

	try {
		const raw = readFileSync(toolsPath, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return;

		for (const item of parsed) {
			const toolParsed = bbDynamicToolSchema.safeParse(item);
			if (!toolParsed.success) continue;
			const def = toolParsed.data;

			pi.registerTool({
				name: def.name,
				label: def.name,
				description: def.description ?? "",
				parameters: def.inputSchema && typeof def.inputSchema === "object" ? def.inputSchema : {},
				execute: async (_toolCallId: string, params: unknown) => {
					return forwardHostToolCall(def.name, params);
				},
			});
		}
	} catch (err) {
		console.warn("[bbToolsExtension] Error registering dynamic tools:", err);
	}
}
