import { type DefaultResourceLoader, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Registry } from "@earendil-works/pi-durable";
import {
	adaptExtensionTool,
	installExtensionTools,
	setupExtensionRunner,
	type NestedToolExecutor,
} from "./extension-bridge.ts";
import type { SessionLocation } from "./upstream/session-storage.ts";
import { runtimeContext } from "./runtime-types.ts";

export function createNestedToolExecutor(registry: Registry): NestedToolExecutor {
	return async (callerId, name, args) => {
		const target = registry.snapshot().tools().find((t) => t.tool.name === name);
		if (!target) {
			return {
				toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args },
				result: { content: [{ type: "text", text: `Tool ${name} not found` }], details: {} },
				isError: true,
			};
		}
		try {
			const res = await target.tool.execute(
				args as never,
				{ callId: `${callerId}/nested`, output: () => {} } as never,
				runtimeContext as never,
			);
			const rawContent = res.content;
			const content = Array.isArray(rawContent)
				? (rawContent as Array<{ type: "text"; text: string }>)
				: [{ type: "text" as const, text: String(rawContent ?? "") }];
			return {
				toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args },
				result: { content, details: res.details },
				isError: !!res.isError,
			};
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args },
				result: { content: [{ type: "text", text: message }], details: {} },
				isError: true,
			};
		}
	};
}

export async function mountExtensionBridge(
	location: SessionLocation,
	modelRuntime: ModelRuntime,
	extensionsResult: ReturnType<DefaultResourceLoader["getExtensions"]>,
	registry: Registry,
	executeToolFn: NestedToolExecutor,
	report: (err: unknown) => void,
): Promise<() => Promise<void>> {
	let extensionRunner: import("@earendil-works/pi-coding-agent").ExtensionRunner | undefined;
	try {
		const syncToolsToRegistry = () => {
			if (!extensionRunner) return;
			const createToolContext = (callId: string) => extensionRunner!.createToolContext(callId, undefined);
			const adapted = extensionRunner.getAllRegisteredTools().map((t) =>
				adaptExtensionTool(t.definition, executeToolFn, createToolContext),
			);
			installExtensionTools(registry, adapted);
		};

		extensionRunner = await setupExtensionRunner({
			extensions: extensionsResult.extensions,
			runtime: extensionsResult.runtime,
			cwd: location.cwd,
			modelRuntime,
			executeToolFn,
			getCallableTools: () =>
				registry.snapshot().tools().map((t) => ({
					name: t.tool.name,
					description: (t.tool as { description?: string }).description ?? "",
					parameters: t.tool.parameters,
				})),
			onToolsChanged: syncToolsToRegistry,
		});

		syncToolsToRegistry();
	} catch (error) {
		report(error);
	}

	return async () => {
		if (extensionRunner) {
			try {
				await extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
			} catch (err) {
				console.warn("[ExtensionBridge] Cleanup session_shutdown failed:", err);
			}
		}
	};
}
