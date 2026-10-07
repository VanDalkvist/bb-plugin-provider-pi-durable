import type { JsonValue } from "@earendil-works/chord";
import {
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
	type Extension,
	type ExtensionFactory,
	type ExtensionRuntime,
	type ExtensionToolContext,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, defineTool, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";

export type NestedToolExecutor = (
	callerId: string,
	name: string,
	args: unknown,
	options?: { signal?: AbortSignal },
) => Promise<{
	toolCall: { type: "toolCall"; id: string; name: string; arguments: unknown };
	result: { content: Array<{ type: "text"; text: string }>; details: unknown };
	isError: boolean;
}>;

/** Safe type guard checking whether an object has an output stream function. */
export function hasOutput(api: unknown): api is { output(text: string): void } {
	return (
		typeof api === "object" &&
		api !== null &&
		"output" in api &&
		typeof (api as { output: unknown }).output === "function"
	);
}

/** Returns the standard built-in extension factories provided by Pi. */
export function createStandardExtensionFactories(): ExtensionFactory[] {
	return [createCodemodeExtension({ mode: "auto" }), createToolSearchExtension(), createMcpExtension()];
}

/** Adapts an extension ToolDefinition to a Durable ToolRegistration without type escape hatches. */
export function adaptExtensionTool(
	toolDef: ToolDefinition,
	executeToolFn: NestedToolExecutor,
	createToolContext?: (callId: string) => ExtensionToolContext,
): ToolRegistration {
	return defineTool({
		name: toolDef.name,
		description: toolDef.description,
		parameters: toolDef.parameters,
		async execute(args, api) {
			const ctx = createToolContext
				? createToolContext(api.callId)
				: ({
						tools: [],
						executeTool: async (name: string, nestedArgs: unknown, options?: { signal?: AbortSignal }) =>
							executeToolFn(api.callId, name, nestedArgs, options),
					} as ExtensionToolContext);

			const result = await toolDef.execute(
				api.callId,
				args,
				undefined,
				(update) => {
					if (update?.content && hasOutput(api)) {
						const textChunks = update.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
						if (textChunks.length > 0) api.output(textChunks);
					}
				},
				ctx,
			);

			return {
				content: result.content,
				isError: result.isError,
				details: (result.details ?? undefined) as JsonValue | undefined,
			};
		},
	});
}

/** Installs adapted tools as a dynamic extension into the Durable Registry. */
export function installExtensionTools(registry: Registry, tools: ToolRegistration[]): void {
	if (tools.length === 0) return;
	registry.install(defineExtension({ name: "extension-tools", tools }));
}

export interface SetupExtensionRunnerOptions {
	extensions: Extension[];
	runtime: ExtensionRuntime;
	cwd: string;
	modelRuntime: ModelRuntime;
	executeToolFn: NestedToolExecutor;
	getCallableTools?: () => Array<{ name: string; description: string; parameters: unknown }>;
	onToolsChanged?: () => void;
}

/** Initializes ExtensionRunner and binds actions and nested tool execution. */
export async function setupExtensionRunner(options: SetupExtensionRunnerOptions): Promise<ExtensionRunner> {
	const sessionManager = SessionManager.create(options.cwd);
	const modelRegistry = new ModelRegistry(options.modelRuntime);
	const runner = new ExtensionRunner(options.extensions, options.runtime, options.cwd, sessionManager, modelRegistry);

	runner.bindCore(
		{
			getActiveTools: () => [],
			getAllTools: () => [],
			getSettings: () => ({}),
			refreshTools: () => {
				options.onToolsChanged?.();
			},
		},
		{
			isProjectTrusted: () => true,
			executeTool: (callerId, name, args, opts) => options.executeToolFn(callerId, name, args, opts),
			getCallableTools: () =>
				options.getCallableTools
					? options.getCallableTools()
					: runner.getAllRegisteredTools().map((t) => ({
							name: t.definition.name,
							description: t.definition.description,
							parameters: t.definition.parameters,
						})),
			getSystemPrompt: () => "",
		},
	);

	await runner.emit({ type: "session_start" });
	return runner;
}
