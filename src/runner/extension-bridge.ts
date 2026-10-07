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
import {
	defineExtension,
	defineTool,
	type Registry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";

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

/** Returns the standard built-in extension factories provided by Pi. */
export function createStandardExtensionFactories(): ExtensionFactory[] {
	return [
		createCodemodeExtension({ mode: "auto" }),
		createToolSearchExtension(),
		createMcpExtension(),
	];
}

/** Adapts an extension ToolDefinition to a Durable ToolRegistration. */
export function adaptExtensionTool(
	toolDef: ToolDefinition,
	executeToolFn: NestedToolExecutor,
): ToolRegistration {
	return defineTool({
		name: toolDef.name,
		description: toolDef.description,
		parameters: toolDef.parameters,
		async execute(args, api) {
			const ctx = {
				executeTool: async (name: string, nestedArgs: unknown, options?: { signal?: AbortSignal }) => {
					return executeToolFn(api.callId, name, nestedArgs, options);
				},
			} as ExtensionToolContext;

			const result = await toolDef.execute(
				api.callId,
				args,
				undefined,
				(update) => {
					if (update?.content && typeof (api as any).output === "function") {
						const textChunks = update.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
						if (textChunks.length > 0) {
							(api as any).output(textChunks);
						}
					}
				},
				ctx,
			);

			return {
				content: result.content,
				isError: result.isError,
				details: result.details as any,
			};
		},
	});
}

/** Installs adapted tools as a dynamic extension into the Durable Registry. */
export function installExtensionTools(registry: Registry, tools: ToolRegistration[]): void {
	if (tools.length === 0) return;
	registry.install(
		defineExtension({
			name: "extension-tools",
			tools,
		}),
	);
}

export interface SetupExtensionRunnerOptions {
	extensions: Extension[];
	runtime: ExtensionRuntime;
	cwd: string;
	modelRuntime: ModelRuntime;
	executeToolFn: NestedToolExecutor;
}

/**
 * Initializes ExtensionRunner, binds actions and nested tool execution,
 * and emits the session_start event to trigger MCP connections and tool registration.
 */
export async function setupExtensionRunner(
	options: SetupExtensionRunnerOptions,
): Promise<ExtensionRunner> {
	const sessionManager = SessionManager.create(options.cwd);
	const modelRegistry = new ModelRegistry(options.modelRuntime);

	const runner = new ExtensionRunner(
		options.extensions,
		options.runtime,
		options.cwd,
		sessionManager,
		modelRegistry,
	);

	runner.bindCore(
		{
			getActiveTools: () => [],
			getAllTools: () => [],
			getSettings: () => ({}),
		},
		{
			executeTool: (callerId, name, args, opts) => options.executeToolFn(callerId, name, args, opts),
			getCallableTools: () => {
				return runner.getAllRegisteredTools().map((t) => ({
					name: t.definition.name,
					description: t.definition.description,
					parameters: t.definition.parameters,
				}));
			},
			getSystemPrompt: () => "",
		},
	);

	await runner.emit({ type: "session_start" });
	return runner;
}
