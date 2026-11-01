import {
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
	type Extension,
	type ExtensionActions,
	type ExtensionContextActions,
	type ExtensionRuntime,
	type ExtensionUIContext,
	type ModelRuntime,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { NestedToolExecutor } from "./tool-adapter.ts";

export {
	adaptExtensionTool,
	createStandardExtensionFactories,
	hasOutput,
	installExtensionTools,
	type NestedToolExecutor,
} from "./tool-adapter.ts";
export { createExtensionActions } from "./extension-actions.ts";
import { createExtensionActions } from "./extension-actions.ts";

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
}

export function createExtensionUIContext(
	onNotice?: (type: "info" | "warning" | "error", message: string) => void,
): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message: string, type: "info" | "warning" | "error" = "info") => {
			onNotice?.(type, message);
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as any,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: {} as any,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

/** Initializes ExtensionRunner and binds actions and nested tool execution. */
export async function setupExtensionRunner(options: SetupExtensionRunnerOptions): Promise<ExtensionRunner> {
	const sessionManager = SessionManager.create(options.cwd);
	const modelRegistry = new ModelRegistry(options.modelRuntime);
	const runner = new ExtensionRunner(options.extensions, options.runtime, options.cwd, sessionManager, modelRegistry);

	runner.setUIContext(createExtensionUIContext(options.onNotice));

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
