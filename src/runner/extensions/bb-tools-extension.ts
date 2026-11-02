import fs from "node:fs";
import { Type } from "typebox";
import type { RegisteredTool, ToolDefinition } from "@earendil-works/pi-coding-agent";
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

export interface BbToolEntry extends RegisteredTool {
	name: string;
	description: string;
	parameters: unknown;
	exposure: "both";
	namespace: { name: string; description: string };
	execute: (_callId: string, args: unknown, _ctx: unknown) => Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError: boolean;
	}>;
	definition: ToolDefinition;
	sourceInfo: {
		type: "synthetic";
		path: string;
		name: string;
	};
}

export function createBbDynamicToolsExtension(options: BbDynamicToolsExtensionOptions) {
	const tools = new Map<string, BbToolEntry>();

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

					const toolDef: ToolDefinition = {
						name: def.name,
						description: def.description ?? "",
						parameters: schema,
						exposure: "both",
						namespace: { name: "bb", description: "Beyond Boundaries dynamic tools" },
						execute: async (_callId: string, args: unknown, _ctx: unknown) => {
							return options.forwardToolCall(def.name, args);
						},
					};

					const toolEntry: BbToolEntry = {
						...toolDef,
						name: def.name,
						description: def.description ?? "",
						parameters: schema,
						exposure: "both",
						namespace: { name: "bb", description: "Beyond Boundaries dynamic tools" },
						execute: toolDef.execute,
						definition: toolDef,
						sourceInfo,
					};
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
		handlers: new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>(),
		tools,
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}
