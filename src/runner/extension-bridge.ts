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
	return [createCodemodeExtension({ mode: "on" }), createToolSearchExtension(), createMcpExtension()];
}

/** Adapts an extension ToolDefinition to a Durable ToolRegistration without type escape hatches. */
export function adaptExtensionTool(
	toolDef: ToolDefinition,
	executeToolFn: NestedToolExecutor,
	createToolContext?: (callId: string) => ExtensionToolContext,
	getExtensionRunner?: () => ExtensionRunner | undefined,
): ToolRegistration {
	return defineTool({
		name: toolDef.name,
		description: toolDef.description,
		parameters: toolDef.parameters,
		async execute(args, api) {
			const runner = getExtensionRunner?.();
			if (runner?.hasHandlers("tool_call")) {
				const hookResult = await runner.emitToolCall({
					type: "tool_call",
					toolName: toolDef.name,
					toolCallId: api.callId,
					input: (args ?? {}) as Record<string, unknown>,
				});
				if (hookResult?.block) {
					return {
						content: [{ type: "text", text: `Tool execution blocked: ${hookResult.reason ?? "policy"}` }],
						isError: true,
					};
				}
			}

			const ctx = createToolContext
				? createToolContext(api.callId)
				: ({
						tools: [],
						executeTool: async (name: string, nestedArgs: unknown, options?: { signal?: AbortSignal }) =>
							executeToolFn(api.callId, name, nestedArgs, options),
					} as unknown as ExtensionToolContext);

			try {
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

				if (runner?.hasHandlers("tool_result")) {
					await runner.emitToolResult({
						type: "tool_result",
						toolName: toolDef.name,
						toolCallId: api.callId,
						input: (args ?? {}) as Record<string, unknown>,
						content: result.content,
						details: (result.details ?? undefined) as JsonValue | undefined,
						isError: result.isError ?? false,
					});
				}

				return {
					content: result.content,
					isError: result.isError,
					details: (result.details ?? undefined) as JsonValue | undefined,
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				const errorContent = [{ type: "text" as const, text: message }];
				if (runner?.hasHandlers("tool_result")) {
					await runner.emitToolResult({
						type: "tool_result",
						toolName: toolDef.name,
						toolCallId: api.callId,
						input: (args ?? {}) as Record<string, unknown>,
						content: errorContent,
						details: undefined,
						isError: true,
					});
				}
				return {
					content: errorContent,
					isError: true,
				};
			}
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
	onNotice?: (level: "info" | "warning" | "error", message: string) => void;
	settingsManager?: import("@earendil-works/pi-coding-agent").SettingsManager;
}

/** Initializes ExtensionRunner and binds actions and nested tool execution. */
export async function setupExtensionRunner(options: SetupExtensionRunnerOptions): Promise<ExtensionRunner> {
	const sessionManager = SessionManager.create(options.cwd);
	const modelRegistry = new ModelRegistry(options.modelRuntime);
	const runner = new ExtensionRunner(options.extensions, options.runtime, options.cwd, sessionManager, modelRegistry);

	if (options.onNotice) {
		const notifyFn = options.onNotice;
		runner.setUIContext({
			notify: (message: string, type: "info" | "warning" | "error" = "info") => {
				notifyFn(type, message);
			},
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionUIContext);
	}

	runner.bindCore(
		{
			getActiveTools: () => (options.getCallableTools ? options.getCallableTools().map((t) => t.name) : []),
			getAllTools: () =>
				runner.getAllRegisteredTools().map((t) => ({
					name: t.definition.name,
					description: t.definition.description,
					parameters: t.definition.parameters,
				})),
			getSettings: () => ({
				...(options.settingsManager?.getGlobalSettings() ?? {}),
				...(options.settingsManager?.getProjectSettings() ?? {}),
			}),
			refreshTools: () => {
				options.onToolsChanged?.();
			},
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionActions,
		{
			isProjectTrusted: () => true,
			executeTool: (callerId: string, name: string, args: unknown, opts?: { signal?: AbortSignal }) =>
				options.executeToolFn(callerId, name, args, opts),
			getCallableTools: () =>
				options.getCallableTools
					? options.getCallableTools()
					: runner.getAllRegisteredTools().map((t) => ({
							name: t.definition.name,
							description: t.definition.description,
							parameters: t.definition.parameters,
						})),
			getSystemPrompt: () => "",
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContextActions,
	);

	await runner.emit({ type: "session_start", reason: "startup" });
	return runner;
}
