import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export interface ExtensionUIDialogRequester {
	(kind: "select" | "confirm" | "input" | "editor", payload: {
		title?: string;
		message?: string;
		data?: unknown;
	}): Promise<unknown>;
}

export function createExtensionUIContext(
	onNotice?: (type: "info" | "warning" | "error", message: string) => void,
	requestInteraction?: ExtensionUIDialogRequester,
): ExtensionUIContext {
	return {
		select: async (title: string, options: string[], dialogOptions?: unknown) => {
			if (requestInteraction) {
				const res = await requestInteraction("select", { title, data: { options, dialogOptions } });
				if (typeof res === "string") return res;
				if (res && typeof res === "object" && "selected" in res) return (res as { selected: string }).selected;
			}
			return undefined;
		},
		confirm: async (title: string, message: string, dialogOptions?: unknown) => {
			if (requestInteraction) {
				const res = await requestInteraction("confirm", { title, message, data: { dialogOptions } });
				if (typeof res === "boolean") return res;
				if (res && typeof res === "object" && "confirmed" in res) return Boolean((res as { confirmed: boolean }).confirmed);
			}
			return false;
		},
		input: async (title: string, placeholder?: string, dialogOptions?: unknown) => {
			if (requestInteraction) {
				const res = await requestInteraction("input", { title, data: { placeholder, dialogOptions } });
				if (typeof res === "string") return res;
				if (res && typeof res === "object" && "value" in res) return (res as { value: string }).value;
			}
			return undefined;
		},
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
		editor: async (title: string, content: string, dialogOptions?: unknown) => {
			if (requestInteraction) {
				const res = await requestInteraction("editor", { title, data: { content, dialogOptions } });
				if (typeof res === "string") return res;
				if (res && typeof res === "object" && "content" in res) return (res as { content: string }).content;
			}
			return undefined;
		},
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
