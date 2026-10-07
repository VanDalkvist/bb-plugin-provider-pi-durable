import {
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createHarnessSettings,
	findInitialAgentModel,
	type ExecutionEnvs,
} from "./harness-setup.ts";
import {
	createStandardExtensionFactories,
	setupExtensionRunner,
	adaptExtensionTool,
	installExtensionTools,
	type NestedToolExecutor,
} from "./extension-bridge.ts";
import { getAgentDir, type SessionLocation } from "./sessions.ts";
import { Subagent } from "./subagent.ts";
import { Harness, type ModelRef } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type OpenDurableOptions, runtimeContext } from "./runtime-types.ts";

export interface LoadedHarnessEnvironment {
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	harness: Harness;
	initialModelRef?: ModelRef;
	fallbackMessage?: string;
	pendingReports: unknown[];
	getActiveModel: () => ModelRef | undefined;
	setActiveModelRef: (ref: ModelRef | undefined) => void;
	cleanup?: () => Promise<void>;
}

export async function loadHarnessEnvironment(
	location: SessionLocation,
	options: OpenDurableOptions,
	envs: ExecutionEnvs,
): Promise<LoadedHarnessEnvironment> {
	const modelRuntime = await ModelRuntime.create();
	const settingsManager = SettingsManager.create(location.cwd);
	const agentDir = getAgentDir();
	const resourceLoader = new DefaultResourceLoader({
		cwd: location.cwd,
		agentDir,
		settingsManager,
		extensionFactories: createStandardExtensionFactories(),
	});
	await resourceLoader.reload();
	const extensionsResult = resourceLoader.getExtensions();

	for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRuntime.registerProvider(name, config);
		} catch {
			// intentionally ignored: provider registration may already exist or be non-critical
		}
	}
	for (const { provider } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
		try {
			modelRuntime.registerNativeProvider(provider);
		} catch {
			// intentionally ignored: native provider may already be registered
		}
	}
	for (const { definition } of extensionsResult.runtime.pendingVirtualModelRegistrations) {
		try {
			modelRuntime.registerVirtualModel(definition);
		} catch {
			// intentionally ignored: virtual model may already be registered
		}
	}

	configureHarnessHttp(settingsManager);
	let activeModelRef: ModelRef | undefined = undefined;
	const getActiveModel = () => {
		if (activeModelRef) return activeModelRef;
		const p = settingsManager.getDefaultProvider();
		const m = settingsManager.getDefaultModel();
		return p && m ? { provider: p, modelId: m } : undefined;
	};

	const settings = createHarnessSettings(settingsManager, getActiveModel);
	const registry = createCodingRegistry(settingsManager, location.cwd, options.prompt);
	registry.install(Subagent);

	const pendingReports: unknown[] = [];
	const report = (error: unknown) => pendingReports.push(error);

	const executeToolFn: NestedToolExecutor = async (callerId, name, args) => {
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
				args as any,
				{
					callId: `${callerId}/nested`,
					output: () => {},
				} as any,
				runtimeContext as any,
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

	let extensionRunner: import("@earendil-works/pi-coding-agent").ExtensionRunner | undefined;
	try {
		const syncToolsToRegistry = () => {
			if (!extensionRunner) return;
			const createToolContext = (callId: string) => extensionRunner!.createToolContext(callId, undefined);
			const registeredTools = extensionRunner.getAllRegisteredTools();
			const adaptedTools = registeredTools.map((t) =>
				adaptExtensionTool(t.definition, executeToolFn, createToolContext),
			);
			installExtensionTools(registry, adaptedTools);
		};

		const getCallableTools = () => {
			return registry.snapshot().tools().map((t) => ({
				name: t.tool.name,
				description: (t.tool as any).description ?? "",
				parameters: t.tool.parameters,
			}));
		};

		extensionRunner = await setupExtensionRunner({
			extensions: extensionsResult.extensions,
			runtime: extensionsResult.runtime,
			cwd: location.cwd,
			modelRuntime,
			executeToolFn,
			getCallableTools,
			onToolsChanged: syncToolsToRegistry,
		});

		syncToolsToRegistry();
	} catch (error) {
		report(error);
	}

	const cleanup = async () => {
		if (extensionRunner) {
			try {
				await extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
			} catch (err) {
				console.warn("[ExtensionBridge] Cleanup session_shutdown failed:", err);
			}
		}
	};

	const harness = await Harness.open(
		await openNodeSqliteStorage(location.database),
		{
			models: modelRuntime,
			registry,
			settings,
			env: envs.env,
			onReport: (error) => report(error),
		},
		runtimeContext,
	);

	const initial = location.created
		? await findInitialAgentModel(settingsManager, modelRuntime, options.cli)
		: undefined;
	if (initial?.model) {
		activeModelRef = initial.model;
	}

	return {
		modelRuntime,
		settingsManager,
		harness,
		initialModelRef: initial?.model,
		fallbackMessage: initial?.fallbackMessage,
		pendingReports,
		getActiveModel,
		setActiveModelRef: (ref) => {
			activeModelRef = ref;
		},
		cleanup,
	};
}
