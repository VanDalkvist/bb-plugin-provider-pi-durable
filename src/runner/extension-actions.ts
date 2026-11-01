import type {
	ExtensionActions,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

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
