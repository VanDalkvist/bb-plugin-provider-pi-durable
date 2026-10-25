import { runCompactionSideEffect } from "./compaction-hooks.ts";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	Conversation,
	ConversationId,
	ConversationView,
	Harness,
	ModelRef,
	Submission,
	TaskGraph,
} from "@earendil-works/pi-durable";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { agentOf, type DurableController, type DurableView, type Notice, runtimeContext } from "./runtime-types.ts";

export interface ControllerContext {
 bindings: import("./runtime-types.ts").RuntimeBindingPort;
 opened: Harness;
 modelRuntime: ModelRuntime;
 getState: () => DurableView;
 notice: (level: Notice["level"], message: string) => void;
 fail: (error: unknown) => void;
 setActiveModelRef: (ref: ModelRef) => void;
 extensionRunner?: import("@earendil-works/pi-coding-agent").ExtensionRunner;
 dynamicSections?: import("./prompt.ts").DynamicPromptSections;
 cwd?: string;
}

export function createDurableController(ctx: ControllerContext): DurableController {
	let queue = Promise.resolve();
	const command = (operation: () => Promise<void>): Promise<void> => {
		queue = queue.then(operation).catch(ctx.fail);
		return queue;
	};

	const watchAnswer = (submission: Submission): void => {
		void submission.wait(runtimeContext).then(async (settled) => {
			if (settled.status === "unanswered" && settled.reason !== "aborted") {
				ctx.notice(
					"error",
					`No answer: ${settled.reason}${settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`}`,
				);
			}
			if (ctx.extensionRunner) {
				try {
					await ctx.extensionRunner.emit({ type: "agent_end", messages: [] });
					await ctx.extensionRunner.emit({ type: "agent_settled", aborted: settled.status === "unanswered" && settled.reason === "aborted" });
				} catch (err) {
					ctx.notice("warning", `agent lifecycle hook error: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}, ctx.fail);
	};

	const agentModel = () => {
		const ref = agentOf(ctx.getState().conversation).model;
		const model = ref === undefined ? undefined : ctx.modelRuntime.getModel(ref.provider, ref.modelId);
		if (model === undefined) {
			throw new Error(ref === undefined ? "No model selected" : "Current model is unavailable");
		}
		return model;
	};

	return {
		submit: (input, whenBusy) =>
			command(async () => {
				const isStr = typeof input === "string";
				const prompt = isStr ? input : input.filter((c) => c.type === "text").map((c: any) => c.text).join("\n");
				const images = isStr ? undefined : (input.filter((c) => c.type === "image") as any[]);
				if (ctx.extensionRunner && ctx.dynamicSections) {
					try {
						const hookRes = await ctx.extensionRunner.emitBeforeAgentStart(
							{ messageType: "user", prompt, images: images?.length ? images : undefined },
							{
								cwd: ctx.cwd ?? process.cwd(),
								sections: ctx.dynamicSections.getSections(),
							} as import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions,
						);
						if (hookRes?.systemPromptOptions?.sections) {
							ctx.dynamicSections.updateSections(hookRes.systemPromptOptions.sections);
						}
					} catch (err) {
						ctx.notice(
							"warning",
							`before_agent_start error: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				return watchAnswer(await ctx.bindings.current.submit({ type: "input", content: input, whenBusy }, runtimeContext));
			}),

		compact: (instructions) =>
			command(async () => {
				const extensionRunner = ctx.extensionRunner;
				if (extensionRunner) {
					const context = await runCompactionSideEffect("compact_context", () => ctx.bindings.current.context(runtimeContext), ctx.notice);
					if (context.status === "succeeded") {
						const ctxView = context.value;
						const msgs = [...ctxView.messages], entries = [...ctxView.entries];
						await runCompactionSideEffect("session_before_compact", () => extensionRunner.emit({
							type: "session_before_compact",
							preparation: { firstKeptEntryId: ctxView.head?.id !== undefined ? String(ctxView.head.id) : "", messagesToSummarize: msgs, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 0, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: {} as any },
							branchEntries: entries as any, customInstructions: instructions, reason: "manual", willRetry: false, signal: new AbortController().signal,
						}), ctx.notice);
					}
				}
				const id = await ctx.bindings.current.compact(instructions, runtimeContext);
				void ctx.opened.waitForTask(id, runtimeContext).then(async (receipt) => {
					const outcome = receipt.state.outcome;
					if (outcome.status === "completed") {
						if (extensionRunner) {
							void runCompactionSideEffect("session_compact", () => extensionRunner.emit({
								type: "session_compact",
								compactionEntry: { id: outcome.result?.entryId ?? "", type: "compaction", summary: "", tokensBefore: 0, tokensAfter: 0 } as any,
								fromExtension: false,
								reason: "manual",
								willRetry: false,
							}), ctx.notice).catch(ctx.fail);
						}
						const { entryId, submissionId } = outcome.result;
						const status = submissionId === undefined ? undefined : (await (await ctx.opened.submission(submissionId, runtimeContext))?.status(runtimeContext))?.status;
						const msg = entryId !== undefined || status === "done" ? "Compacted."
							: status === "queued" ? "Compaction summary queued; it is placed at the next turn boundary."
							: status === "unanswered" ? "Compaction summary dropped: the context changed under it."
							: "Nothing to compact: the context fits in the recent window that is kept verbatim.";
						ctx.notice("info", msg);
					} else if (outcome.status === "aborted") {
						ctx.notice("info", "Compaction aborted.");
					} else {
						ctx.notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
					}
				}).catch(ctx.fail);
			}),

		abort: () => ctx.bindings.current.abort(runtimeContext).catch(ctx.fail),

		cycleThinking: () =>
			command(async () => {
				const model = agentModel();
				if (!model.reasoning) throw new Error("Current model does not support thinking");
				const levels = getSupportedThinkingLevels(model), level = agentOf(ctx.getState().conversation).thinkingLevel ?? "off";
				await ctx.bindings.current.configure({ thinkingLevel: levels[(levels.indexOf(level) + 1) % levels.length] ?? "off" }, runtimeContext);
			}),

		setThinkingLevel: (targetLevel: ModelThinkingLevel) =>
			command(async () => {
				const model = agentModel();
				if (!model.reasoning) {
					if (targetLevel === "off" || (targetLevel as string) === "none") {
						return void (await ctx.bindings.current.configure({ thinkingLevel: "off" }, runtimeContext));
					}
					throw new Error("Current model does not support thinking");
				}
				await ctx.bindings.current.configure({ thinkingLevel: clampThinkingLevel(model, targetLevel) }, runtimeContext);
			}),

		setModel: (ref) =>
			command(async () => {
				const model = ctx.modelRuntime.getModel(ref.provider, ref.modelId);
				if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
				ctx.setActiveModelRef(ref);
				const thinking: ModelThinkingLevel = agentOf(ctx.getState().conversation).thinkingLevel ?? "off";
				await ctx.bindings.current.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, runtimeContext);
			}),

		toggleTasks: () =>
			command(async () => {
				if (ctx.bindings.tasksOpen) return ctx.bindings.closeTasks();
				ctx.bindings.attachTasks(await ctx.opened.taskGraph(runtimeContext));
			}),

		switchConversation: (id: ConversationId) =>
			command(async () => {
				const next = await ctx.opened.conversation(id, runtimeContext);
				if (next === undefined) throw new Error(`Conversation ${id} does not exist`);
				ctx.bindings.bindConversation(next, await next.viewState(runtimeContext));
			}),
	};
}
