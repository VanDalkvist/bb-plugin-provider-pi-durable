import {
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
	type ExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createHarnessSettings,
	findInitialAgentModel,
	type ExecutionEnvs,
} from "./harness-setup.ts";
import { createStandardExtensionFactories } from "./extension-bridge.ts";
import { createNestedToolExecutor, mountExtensionBridge } from "./extension-mount.ts";
import { getAgentDir, type SessionLocation } from "./upstream/session-storage.ts";
import { Subagent } from "./upstream/subagent-tool.ts";
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

function registerPendingProviders(modelRuntime: ModelRuntime, runtime: ExtensionRuntime): void {
	for (const { name, config } of runtime.pendingProviderRegistrations) {
		try { modelRuntime.registerProvider(name, config); } catch { /* ignore duplicate */ }
	}
	for (const { provider } of runtime.pendingNativeProviderRegistrations) {
		try { modelRuntime.registerNativeProvider(provider); } catch { /* ignore duplicate */ }
	}
	for (const { definition } of runtime.pendingVirtualModelRegistrations) {
		try { modelRuntime.registerVirtualModel(definition); } catch { /* ignore duplicate */ }
	}
}

export async function loadHarnessEnvironment(
	location: SessionLocation,
	options: OpenDurableOptions,
	envs: ExecutionEnvs,
): Promise<LoadedHarnessEnvironment> {
	const modelRuntime = await ModelRuntime.create();
	const settingsManager = SettingsManager.create(location.cwd);
	const resourceLoader = new DefaultResourceLoader({
		cwd: location.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		extensionFactories: createStandardExtensionFactories(),
	});
	await resourceLoader.reload();
	const extensionsResult = resourceLoader.getExtensions();

	registerPendingProviders(modelRuntime, extensionsResult.runtime);
	configureHarnessHttp(settingsManager);

	let activeModelRef: ModelRef | undefined;
	const getActiveModel = () => {
		if (activeModelRef) return activeModelRef;
		const p = settingsManager.getDefaultProvider();
		const m = settingsManager.getDefaultModel();
		return p && m ? { provider: p, modelId: m } : undefined;
	};

	const settings = createHarnessSettings(settingsManager, getActiveModel);
	const registry = createCodingRegistry(settingsManager, location.cwd, {
		...options.prompt,
		resourceLoader,
	});
	registry.install(Subagent);

	const pendingReports: unknown[] = [];
	const report = (error: unknown) => pendingReports.push(error);

	const executeToolFn = createNestedToolExecutor(registry);
	const cleanup = await mountExtensionBridge(
		location,
		modelRuntime,
		extensionsResult,
		registry,
		executeToolFn,
		report,
	);

	const harness = await Harness.open(
		await openNodeSqliteStorage(location.database),
		{ models: modelRuntime, registry, settings, env: envs.env, onReport: report },
		runtimeContext,
	);

	const initial = location.created
		? await findInitialAgentModel(settingsManager, modelRuntime, options.cli)
		: undefined;
	if (initial?.model) activeModelRef = initial.model;

	return {
		modelRuntime,
		settingsManager,
		harness,
		initialModelRef: initial?.model,
		fallbackMessage: initial?.fallbackMessage,
		pendingReports,
		getActiveModel,
		setActiveModelRef: (ref) => { activeModelRef = ref; },
		cleanup,
	};
}
