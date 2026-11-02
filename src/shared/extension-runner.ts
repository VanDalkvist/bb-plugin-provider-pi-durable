import {
	createMcpExtension,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
	type Extension,
	type ExtensionActions,
	type ExtensionContextActions,
	type ExtensionFactory,
	type ExtensionRuntime,
	type ExtensionUIContext,
	type ModelRuntime,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";

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

export function createStandardExtensionFactories(): ExtensionFactory[] {
	return [createMcpExtension()];
}

import { createExtensionUIContext } from "./extension-ui-context.ts";
export { createExtensionUIContext };

export interface CreateExtensionActionsOptions {
	getRegisteredTools?: () => Array<{ definition: { name: string; description?: string; parameters?: unknown; promptGuidelines?: string; exposure?: string; namespace?: string; annotations?: unknown }; sourceInfo?: unknown }>;
	getCallableTools?: () => Array<{ name: string; description: string; parameters: unknown }>;
	settingsManager?: SettingsManager;
	onActiveToolsChanged?: (tools: string[]) => void;
	onToolsChanged?: () => void;
	sessionManager?: SessionManager;
	onSubmitUserMessage?: (content: any, deliverAs?: "steer" | "followUp") => Promise<void> | void;
}

export function createExtensionActions(
	options: CreateExtensionActionsOptions,
	initialActiveTools: string[] = [],
): ExtensionActions {
	let activeToolNames = [...initialActiveTools];
	let sessionName: string | undefined;

	const sendMessage: ExtensionActions["sendMessage"] = (message: any, sendOptions?: any) => {
		if (sendOptions?.triggerTurn && message?.content) {
			const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
			void options.onSubmitUserMessage?.(text, sendOptions.deliverAs === "steer" ? "steer" : "followUp");
		}
	};

	const sendUserMessage: ExtensionActions["sendUserMessage"] = (content: any, sendOptions?: any) => {
		void options.onSubmitUserMessage?.(content, sendOptions?.deliverAs);
	};

	return {
		getActiveTools: () => activeToolNames,
		getAllTools: () => {
			const map = new Map<string, unknown>();
			if (options.getCallableTools) {
				for (const t of options.getCallableTools()) {
					map.set(t.name, {
						name: t.name,
						description: t.description,
						parameters: t.parameters,
						exposure: "direct",
						reachesTools: t.name === "codemode" || t.name === "tool_search",
					});
				}
			}
			if (options.getRegisteredTools) {
				for (const t of options.getRegisteredTools()) {
					map.set(t.definition.name, {
						name: t.definition.name,
						description: t.definition.description,
						parameters: t.definition.parameters,
						promptGuidelines: t.definition.promptGuidelines,
						exposure: t.definition.exposure ?? "direct",
						namespace: t.definition.namespace,
						annotations: t.definition.annotations,
						sourceInfo: t.sourceInfo,
					});
				}
			}
			return Array.from(map.values()) as any;
		},
		getSettings: () => ({
			...(options.settingsManager?.getGlobalSettings() ?? {}),
			...(options.settingsManager?.getProjectSettings() ?? {}),
		}),
		setActiveTools: (toolNames: string[]) => {
			activeToolNames = [...toolNames];
			options.onActiveToolsChanged?.(activeToolNames);
		},
		refreshTools: () => {
			options.onToolsChanged?.();
		},
		getThinkingLevel: () => (options.settingsManager?.getDefaultThinkingLevel?.() ?? "high") as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
		setThinkingLevel: () => {},
		setModel: async () => false,
		getCommands: () => [],
		sendMessage,
		sendUserMessage,
		appendEntry: (customType: string, data?: unknown) => {
			options.sessionManager?.appendCustomEntry(customType, data);
		},
		setSessionName: (name: string) => {
			sessionName = name;
		},
		getSessionName: () => sessionName,
		setLabel: () => {},
	};
}

export interface SetupExtensionRunnerOptions {
	extensions: Extension[];
	runtime: ExtensionRuntime;
	cwd: string;
	modelRuntime: ModelRuntime;
	executeToolFn: NestedToolExecutor;
	getCallableTools?: () => Array<{ name: string; description: string; parameters: unknown }>;
	onToolsChanged?: () => void;
	onActiveToolsChanged?: (tools: string[]) => void;
	initialActiveTools?: string[];
	onNotice?: (level: "info" | "warning" | "error", message: string) => void;
	settingsManager?: SettingsManager;
	onAbort?: () => void;
	onCompact?: (instructions?: string) => void;
	getContextUsage?: () => { tokens: number | null; contextWindow: number } | undefined;
	isIdle?: () => boolean;
	onSubmitUserMessage?: (content: string, deliverAs?: "steer" | "followUp") => Promise<void> | void;
	requestInteraction?: import("./extension-ui-context.ts").ExtensionUIDialogRequester;
}

export async function setupExtensionRunner(options: SetupExtensionRunnerOptions): Promise<ExtensionRunner> {
	const sessionManager = SessionManager.create(options.cwd);
	const modelRegistry = new ModelRegistry(options.modelRuntime);
	const runner = new ExtensionRunner(options.extensions, options.runtime, options.cwd, sessionManager, modelRegistry);

	runner.setUIContext(createExtensionUIContext(options.onNotice, options.requestInteraction));

	const initialActive = options.initialActiveTools
		? [...options.initialActiveTools]
		: (options.getCallableTools ? options.getCallableTools().map((t) => t.name) : []);

	const actions = createExtensionActions({
		getRegisteredTools: () => runner.getAllRegisteredTools() as any,
		getCallableTools: options.getCallableTools,
		settingsManager: options.settingsManager,
		onActiveToolsChanged: options.onActiveToolsChanged,
		onToolsChanged: options.onToolsChanged,
		sessionManager,
		onSubmitUserMessage: options.onSubmitUserMessage,
	}, initialActive);

	const contextActions: ExtensionContextActions = {
		getModel: () => {
			const active = options.settingsManager?.getDefaultModel?.();
			const provider = options.settingsManager?.getDefaultProvider?.();
			if (active && provider) {
				const found = options.modelRuntime.getModel(provider, active);
				if (found) return found;
			}
			return options.modelRuntime.getAvailableSnapshot()[0];
		},
		getScopedModels: () => options.modelRuntime.getAvailableSnapshot().map((model) => ({ model })),
		isIdle: () => (options.isIdle ? options.isIdle() : true),
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => { options.onAbort?.(); },
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => {
			const u = options.getContextUsage?.();
			if (!u) return undefined;
			const pct = typeof u.tokens === "number" && u.contextWindow > 0 ? (u.tokens / u.contextWindow) * 100 : null;
			return { tokens: u.tokens, contextWindow: u.contextWindow, percent: pct };
		},
		compact: (opts?: { customInstructions?: string } | string) => {
			options.onCompact?.(typeof opts === "string" ? opts : opts?.customInstructions);
		},
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({ cwd: options.cwd }),
		executeTool: (callerId: string, name: string, args: unknown, opts?: { signal?: AbortSignal }) =>
			options.executeToolFn(callerId, name, args, opts) as any,
		getCallableTools: () =>
			options.getCallableTools
				? (options.getCallableTools() as any)
				: (runner.getAllRegisteredTools().map((t) => ({
						name: t.definition.name,
						description: t.definition.description,
						parameters: t.definition.parameters,
						promptGuidelines: t.definition.promptGuidelines,
						exposure: t.definition.exposure,
						namespace: t.definition.namespace,
						annotations: t.definition.annotations,
						sourceInfo: t.sourceInfo,
					})) as any),
	};

	runner.bindCore(actions, contextActions);

	await runner.emit({ type: "session_start", reason: "startup" });
	return runner;
}
