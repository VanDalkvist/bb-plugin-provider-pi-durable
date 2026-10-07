import type { AttachedReplicatedState } from "@earendil-works/chord";
import type {
	Conversation,
	ConversationId,
	ConversationView,
	Cursor,
	Harness,
	TaskGraph,
} from "@earendil-works/pi-durable";
import { resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { ExecutionEnvs, findInitialAgentModel } from "./harness-setup.ts";
import { selectSession } from "./sessions.ts";
import {
	agentOf,
	firstInput,
	titleOf,
	type ConversationSummary,
	type DurableView,
	type ModelSummary,
	type Notice,
	type OpenDurableOptions,
	type OpenDurableResult,
	runtimeContext,
} from "./runtime-types.ts";
import { createDurableController } from "./runtime-controller.ts";
import { loadHarnessEnvironment } from "./runtime-loader.ts";

export * from "./runtime-types.ts";
export * from "./runtime-controller.ts";

export async function openDurable(options: OpenDurableOptions = {}): Promise<OpenDurableResult> {
	const location = await selectSession(options.cwd ?? process.cwd(), options.continueSession ?? false, options.session);
	const envs = new ExecutionEnvs(location.cwd);
	let harness: Harness | undefined;

	try {
		const envState = await loadHarnessEnvironment(location, options, envs);
		const { modelRuntime, settingsManager } = envState;
		harness = envState.harness;

		const root = await harness.root(runtimeContext, {
			agent: {
				cwd: location.cwd,
				...(envState.initialModelRef === undefined ? {} : { model: envState.initialModelRef }),
			},
		});

		if (!location.created) {
			const rootAgent = await root.agent(runtimeContext);
			if (rootAgent.model) {
				envState.setActiveModelRef(rootAgent.model);
			}
		}

		if (!location.created && options.cli !== undefined) {
			const cliModel = await findInitialAgentModel(settingsManager, modelRuntime, options.cli);
			if (cliModel.model !== undefined) {
				envState.setActiveModelRef(cliModel.model);
				await root.configure({ model: cliModel.model, thinkingLevel: cliModel.thinkingLevel }, runtimeContext);
			}
		}

		const label = (id: ConversationId): string => (id === root.id ? "main" : `subagent ${id}`);
		const opened = harness;
		const summaries: ConversationSummary[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await opened.commit((tx) => tx.scanConversations({}, 256, cursor), runtimeContext);
			for (const { id } of page.items) summaries.push({ id, label: label(id), ...(await firstInput(opened, id)) });
			cursor = page.next;
		} while (cursor !== undefined);

		let current: Conversation = root;
		let conversation: AttachedReplicatedState<ConversationView> = await root.viewState(runtimeContext);

		const enabledPatterns = settingsManager.getEnabledModels();
		const scopedScope = enabledPatterns && enabledPatterns.length > 0
			? await resolveModelScopeWithDiagnostics(enabledPatterns, modelRuntime)
			: undefined;
		const scopedModelList = scopedScope && scopedScope.scopedModels.length > 0
			? scopedScope.scopedModels.map((sm) => sm.model)
			: modelRuntime.getAvailableSnapshot();

		const models = (): ModelSummary[] =>
			scopedModelList.map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
			}));

		let state: DurableView = {
			session: { id: location.id, directory: location.directory, cwd: location.cwd },
			conversation: conversation.value,
			conversations: summaries,
			models: models(),
			notices: [],
		};

		const listeners = new Set<() => void>();
		let notifying = false;
		const update = (patch: Partial<DurableView>): void => {
			state = { ...state, ...patch };
			if (notifying) return;
			notifying = true;
			setImmediate(() => {
				notifying = false;
				for (const listener of listeners) listener();
			});
		};

		let nextNotice = 1;
		const notice = (level: Notice["level"], message: string): void => {
			update({ notices: [...state.notices, { id: nextNotice++, level, message }].slice(-20) });
		};
		const fail = (error: unknown): void => notice("error", error instanceof Error ? error.message : String(error));
		for (const error of envState.pendingReports) {
			notice("warning", error instanceof Error ? error.message : String(error));
		}

		let unsubscribeConversation = conversation.subscribe((value) => update({ conversation: value }));
		const unsubscribeCommits = harness.subscribeCommits((publication) => {
			let conversations = state.conversations;
			for (const change of publication.changes) {
				if (change.type === "conversation") {
					conversations = [...conversations, { id: change.value.id, label: label(change.value.id) }];
				} else if (change.type === "entry" && change.value.kind === "pi.user") {
					const id = change.value.conversationId;
					conversations = conversations.map((summary) =>
						summary.id === id && summary.title === undefined ? { ...summary, ...titleOf(change.value) } : summary,
					);
				}
			}
			if (conversations !== state.conversations) update({ conversations });
		});

		let tasks: AttachedReplicatedState<TaskGraph> | undefined;
		let unsubscribeTasks = (): void => {};
		const closeTasks = (): void => {
			unsubscribeTasks();
			tasks?.dispose();
			tasks = undefined;
		};

		const controller = createDurableController({
			getCurrent: () => current,
			setCurrent: (c) => { current = c; },
			getConversationState: () => conversation,
			setConversationState: (cs) => { conversation = cs; },
			getUnsubscribeConversation: () => unsubscribeConversation,
			setUnsubscribeConversation: (fn) => { unsubscribeConversation = fn; },
			opened,
			modelRuntime,
			getState: () => state,
			update,
			notice,
			fail,
			getTasks: () => tasks,
			setTasks: (t) => { tasks = t; },
			setUnsubscribeTasks: (fn) => { unsubscribeTasks = fn; },
			closeTasks,
			setActiveModelRef: (ref) => envState.setActiveModelRef(ref),
		});

		const saved = agentOf(state.conversation).model;
		if (saved === undefined) notice("warning", "No model configured; select one with /model.");
		else if (modelRuntime.getModel(saved.provider, saved.modelId) === undefined) {
			notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
		}
		if (envState.fallbackMessage !== undefined) notice("info", envState.fallbackMessage);

		await controller.toggleTasks();
		harness.resume();

		let closing: Promise<void> | undefined;
		return {
			view: {
				current: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			controller,
			settings: settingsManager,
			modelRuntime,
			harness,
			close() {
				closing ??= (async () => {
					unsubscribeConversation();
					unsubscribeCommits();
					conversation.dispose();
					closeTasks();
					try {
						await opened.close(runtimeContext);
						await envs.cleanup(runtimeContext);
					} finally {
						await location.release();
					}
				})();
				return closing;
			},
		};
	} catch (error) {
		await harness?.close(runtimeContext).catch((err) => {
			console.warn("[DurableRuntime] Cleanup harness close failed:", err);
		});
		await location.release().catch((err) => {
			console.warn("[DurableRuntime] Cleanup location release failed:", err);
		});
		throw error;
	}
}
