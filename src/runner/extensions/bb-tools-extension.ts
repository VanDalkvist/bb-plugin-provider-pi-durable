import fs from "node:fs";
import { Type } from "typebox";
import { bbDynamicToolSchema } from "../../contracts/bb-tools.ts";

export interface ForwardToolCallFn {
	(name: string, args: unknown): Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError: boolean;
	}>;
}

export interface BbDynamicToolsExtensionOptions {
	toolsFilePath?: string;
	forwardToolCall: ForwardToolCallFn;
}

export function createBbDynamicToolsExtension(options: BbDynamicToolsExtensionOptions) {
	const tools = new Map<string, any>();

	if (options.toolsFilePath && fs.existsSync(options.toolsFilePath)) {
		try {
			const raw = fs.readFileSync(options.toolsFilePath, "utf8");
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					const toolParsed = bbDynamicToolSchema.safeParse(item);
					if (!toolParsed.success) continue;
					const def = toolParsed.data;

					const schema = def.inputSchema && typeof def.inputSchema === "object"
						? Type.Unsafe(def.inputSchema as Record<string, unknown>)
						: Type.Object({}, { additionalProperties: true });

					const sourceInfo = {
						type: "synthetic" as const,
						path: options.toolsFilePath,
						name: "bb-dynamic-tools",
					};

					const toolEntry: any = {
						name: def.name,
						description: def.description ?? "",
						parameters: schema,
						exposure: "both",
						namespace: "bb",
						execute: async (_callId: string, args: unknown, _ctx: unknown) => {
							return options.forwardToolCall(def.name, args);
						},
						sourceInfo,
					};
					toolEntry.definition = toolEntry;
					tools.set(def.name, toolEntry);
				}
			}
		} catch (err) {
			console.warn("[BbToolsExtension] Failed to read tools file:", err);
		}
	}

	return {
		path: options.toolsFilePath ?? "bb-dynamic-tools",
		resolvedPath: options.toolsFilePath ?? "bb-dynamic-tools",
		sourceInfo: {
			type: "synthetic" as const,
			path: options.toolsFilePath ?? "bb-dynamic-tools",
			name: "bb-dynamic-tools",
		},
		handlers: new Map(),
		tools,
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}
