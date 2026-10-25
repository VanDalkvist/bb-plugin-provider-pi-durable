import { RunnerProcess } from "./runner-process.ts";
import { DeltaTranslator } from "./delta-translator.ts";
import { buildRunnerArgs, createReadyDeferred, waitForReady, extractSessionStats, createContextWindowDelta, type SessionStats } from "./session-telemetry.ts";
import { SessionSubagentHandler } from "./session-subagent-handler.ts";
import { DurableBindingManager } from "./durable-binding-store.ts";
import type { SubagentMirrorRecord } from "./subagent-mirror.ts";
import type { SubagentPolicyRecord } from "../policy/types.ts";
import type { RunnerEvent, SessionOptions } from "./types.ts";

export type { SubagentMirrorRecord };

export class PiThreadSession {
	public options: SessionOptions;
	private sendNotification: (method: string, params: Record<string, unknown>) => void;
	public runner: RunnerProcess;
	public translator = new DeltaTranslator();
	public readyPromise: Promise<void>;
	private readyResolve: () => void;
	private readyReject: (err: Error) => void;
	public isProcessing = false;
	private lastCheckpointId: string | null = null;
	public bindings = new DurableBindingManager();
	private subagents = new SessionSubagentHandler();
	private acknowledgedSubagentPolicyRevision?: number = undefined;

	constructor(options: SessionOptions, sendNotification: (method: string, params: Record<string, unknown>) => void) {
		this.options = options;
		this.sendNotification = sendNotification;
		const deferred = createReadyDeferred();
		this.readyPromise = deferred.promise;
		this.readyResolve = deferred.resolve;
		this.readyReject = deferred.reject;
		this.runner = new RunnerProcess({
			cwd: options.cwd || process.cwd(),
			args: buildRunnerArgs(options),
			prompts: { scratchDir: options.scratchDir, systemPrompt: options.systemPrompt, appendSystemPrompt: options.appendSystemPrompt },
			env: options.shellEnvOverrides,
			onEvent: (event) => this.handleRunnerEvent(event),
			onChannelMessage: (msg: any) => { if (msg?.kind === "ready") this.readyResolve(); },
			onError: (err) => this.readyReject(new Error(`Runner failed to launch: ${err.message}`)),
			onExit: (code, sig) => this.readyReject(new Error(`Runner exited before becoming ready (code ${code}, signal ${sig})`)),
		});
		this.bindings.setRpc((cmd) => this.runner.requestOk(cmd));
	}

	public registerThread(threadId: string, conversationId?: string): void {
		this.bindings.register(threadId, conversationId, this.options.threadId);
		if (conversationId) {
			this.subagents.flushBufferedDeltas(conversationId, threadId, {
				cwd: this.options.cwd,
				providerOptions: this.options.providerOptions,
			}, this.sendNotification);
		}
	}

	public unregisterThread(threadId: string): void {
		this.bindings.unregister(threadId);
		this.subagents.unregisterChild(threadId);
	}

	public getThreadIdForConversation(conversationId: string | number): string | undefined {
		return this.bindings.getThreadId(conversationId);
	}
	public getConversationIdForThread(threadId: string): string | undefined {
		return this.bindings.getConversationId(threadId);
	}

	public markSubagentActive(id: string | number, meta: { task: string; parentToolCallId?: string; actualModel?: { provider: string; modelId: string }; thinkingLevel?: string; source?: "inherit" | "configured"; policyRevision?: number }): void {
		this.subagents.markActive(id, meta);
	}
	public markSubagentCompleted(id: string | number, result?: string): void { this.subagents.markCompleted(id, result); }
	public consumeCompletedMirror(id: string | number): void { this.subagents.consumeCompleted(id); }
	public findSubagentConversationForTask(task: string): string | undefined { return this.subagents.findConversationForTask(task); }
	public getSubagentState(id: string | number): SubagentMirrorRecord | undefined { return this.subagents.getState(id); }
	public getMirrorOutputText(id: string | number): string { return this.subagents.getOutputText(id); }

	public getAcknowledgedSubagentPolicyRevision(): number | undefined {
		return this.acknowledgedSubagentPolicyRevision;
	}

	public async setSubagentPolicy(record: SubagentPolicyRecord): Promise<void> {
		await this.runner.requestOk({ type: "set_subagent_policy", policyRecord: record });
		this.acknowledgedSubagentPolicyRevision = record.revision;
		if (!this.options.providerOptions) {
			this.options.providerOptions = {};
		}
		this.options.providerOptions.subagentPolicy = record;
	}

	public async start(): Promise<void> {
		try {
			await waitForReady(this.readyPromise);
			await this.bindings.hydrateFromRunner();
			await this.refreshContextUsage();
		} catch (err) {
			this.kill();
			throw err;
		}
	}

	private async handleRunnerEvent(event: RunnerEvent) {
		if (typeof event.providerCheckpointId === "string" && event.providerCheckpointId.length > 0) {
			this.lastCheckpointId = event.providerCheckpointId;
		}

		if (event.type === "agent_end") {
			try {
				await this.refreshContextUsage();
			} catch (err) {
				console.warn(`[PiThreadSession] Context refresh failed before agent_end: ${err}`);
			}
		}

		const shouldDropFromParent = this.subagents.handleEvent(event, this, this.sendNotification);
		if (shouldDropFromParent) return;

		const parentDeltas = this.translator.translate(event, {
			threadId: this.options.threadId,
			cwd: this.options.cwd,
			providerOptions: this.options.providerOptions,
		});
		if (parentDeltas.length > 0) {
			this.sendNotification("thread/delta", { threadId: this.options.threadId, deltas: parentDeltas });
		}

		if (event.type === "turn_end" || event.type === "compaction_end") {
			try {
				await this.refreshContextUsage();
			} catch (err) {
				console.warn(`[PiThreadSession] Context refresh failed after ${event.type}: ${err}`);
			}
		}
	}

	public async prompt(text: string, imagesOrConversationId?: import("./prompt-input.ts").PiPromptImage[] | string, conversationId?: string): Promise<void> {
		this.isProcessing = true;
		try {
			const images = Array.isArray(imagesOrConversationId) ? imagesOrConversationId : undefined;
			const targetConvId = typeof imagesOrConversationId === "string" ? imagesOrConversationId : conversationId;
			await this.runner.requestOk({ type: "prompt", message: text, ...(images?.length ? { images } : {}), streamingBehavior: "followUp", conversationId: targetConvId });
		} finally { this.isProcessing = false; }
	}
	public async steer(text: string, imagesOrConversationId?: import("./prompt-input.ts").PiPromptImage[] | string, conversationId?: string): Promise<void> {
		const images = Array.isArray(imagesOrConversationId) ? imagesOrConversationId : undefined;
		const targetConvId = typeof imagesOrConversationId === "string" ? imagesOrConversationId : conversationId;
		await this.runner.requestOk({ type: "steer", message: text, ...(images?.length ? { images } : {}), conversationId: targetConvId });
	}
	public async abort(conversationId?: string): Promise<void> {
		try { await this.runner.requestOk({ type: "abort", conversationId }); } catch (err) { console.warn(`[PiThreadSession] Abort request failed: ${err}`); }
	}
	public async compact(instructions?: string): Promise<void> {
		this.isProcessing = true;
		try { await this.runner.requestOk({ type: "compact", instructions }); } finally { this.isProcessing = false; }
	}

	public async setModel(provider: string, modelId: string): Promise<void> {
		await this.runner.requestOk({ type: "set_model", provider, modelId });
		this.options.model = { provider, id: modelId };
	}
	public async setThinkingLevel(level: string): Promise<void> {
		await this.runner.requestOk({ type: "set_thinking_level", level });
		this.options.thinkingLevel = level;
	}

	public async refreshContextUsage(): Promise<void> {
		const stats = await this.getSessionStats();
		const delta = createContextWindowDelta(stats);
		if (delta) {
			this.sendNotification("thread/delta", { threadId: this.options.threadId, deltas: [delta] });
		}
	}

	public getLastCheckpointId(): string | null { return this.lastCheckpointId; }
	public async getSessionStats(): Promise<SessionStats> {
		const res = await this.runner.requestOk({ type: "get_session_stats" });
		return extractSessionStats(res);
	}
	public async closeGracefully(): Promise<void> { await this.runner.closeGracefully(); }
	public kill(): void { this.runner.kill(); }
}
