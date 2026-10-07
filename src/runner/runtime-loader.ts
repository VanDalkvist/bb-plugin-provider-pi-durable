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
}

export async function loadHarnessEnvironment(
	location: SessionLocation,
	options: OpenDurableOptions,
	envs: ExecutionEnvs,
): Promise<LoadedHarnessEnvironment> {
	const modelRuntime = await ModelRuntime.create();
	const settingsManager = SettingsManager.create(location.cwd);
	const agentDir = getAgentDir();
	const resourceLoader = new DefaultResourceLoader({ cwd: location.cwd, agentDir, settingsManager });
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
	};
}
