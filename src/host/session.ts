import { requireExtensionPath, requireScratchDir, resolveSessionDir, resolveSessionFilePath } from "./paths.ts";
import { RunnerProcess } from "./runner-process.ts";
import { DeltaTranslator } from "./delta-translator.ts";
import type { SessionOptions } from "./types.ts";

export class PiThreadSession {
	public runner: RunnerProcess;
	public translator = new DeltaTranslator();
	public readyPromise: Promise<void>;
	private readyResolve!: () => void;
	public isProcessing = false;

	constructor(
		public options: SessionOptions,
		private sendNotification: (method: string, params: any) => void,
	) {
		this.readyPromise = new Promise((resolve) => {
			this.readyResolve = resolve;
		});

		const args = ["--mode", "rpc"];
		if (options.noSession) {
			args.push("--no-session");
		} else {
			args.push("--session", options.sessionFilePath);
		}
		args.push("--session-dir", options.sessionDir);
		args.push("--extension", options.extensionPath);

		if (options.model) {
			args.push("--provider", options.model.provider, "--model", options.model.id);
		}
		if (options.thinkingLevel) {
			args.push("--thinking", options.thinkingLevel);
		}
		if (options.appendSystemPrompt) {
			args.push("--append-system-prompt", options.appendSystemPrompt);
		}

		this.runner = new RunnerProcess({
			cwd: options.cwd || process.cwd(),
			args,
			env: options.shellEnvOverrides,
			onEvent: (event) => this.handleRunnerEvent(event),
			onChannelMessage: (msg) => {
				if (msg.kind === "ready") {
					this.readyResolve();
				}
			},
		});
	}

	public async start(): Promise<void> {
		await Promise.race([
			this.readyPromise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("Runner startup ready timed out")), 20000)),
		]).catch(() => {});
		await this.refreshContextUsage().catch(() => {});
	}

	private async handleRunnerEvent(event: any) {
		const deltas = this.translator.translate(event, {
			threadId: this.options.threadId,
			cwd: this.options.cwd,
		});
		if (deltas.length > 0) {
			this.sendNotification("thread/delta", {
				threadId: this.options.threadId,
				deltas,
			});
		}

		if (event.type === "turn_end" || event.type === "compaction_end" || event.type === "agent_end") {
			await this.refreshContextUsage().catch(() => {});
		}
	}

	public async prompt(text: string): Promise<void> {
		this.isProcessing = true;
		try {
			await this.runner.requestOk({
				type: "prompt",
				message: text,
				streamingBehavior: "followUp",
			});
		} finally {
			this.isProcessing = false;
		}
	}

	public async steer(text: string): Promise<void> {
		await this.runner.requestOk({
			type: "prompt",
			message: text,
			streamingBehavior: "steer",
		});
	}

	public async compact(instructions?: string): Promise<void> {
		this.isProcessing = true;
		try {
			await this.runner.requestOk({
				type: "compact",
				instructions,
			});
		} finally {
			this.isProcessing = false;
		}
	}

	public async refreshContextUsage(): Promise<void> {
		const stats = await this.getSessionStats();
		if (stats && typeof stats.contextWindow === "number" && stats.contextWindow > 0) {
			this.sendNotification("thread/delta", {
				threadId: this.options.threadId,
				deltas: [
					{
						kind: "contextWindow",
						used: stats.tokens,
						size: stats.contextWindow,
						estimated: true,
						attach: "currentOrLast",
					},
				],
			});
		}
	}

	public async getSessionStats(): Promise<{ tokens: number | null; contextWindow: number }> {
		const res = await this.runner.requestOk({ type: "get_session_stats" });
		return res?.contextUsage ?? { tokens: null, contextWindow: 0 };
	}

	public async closeGracefully(): Promise<void> {
		await this.runner.closeGracefully();
	}

	public kill(): void {
		this.runner.kill();
	}
}

export class SessionRegistry {
	private sessions = new Map<string, PiThreadSession>();

	constructor(private sendNotification: (method: string, params: any) => void) {}

	public get(threadId: string): PiThreadSession | undefined {
		return this.sessions.get(threadId);
	}

	public async createOrGet(
		threadId: string,
		providerThreadId: string,
		params: any,
	): Promise<PiThreadSession> {
		const existing = this.sessions.get(threadId);
		if (existing && !existing.runner.exited) {
			return existing;
		}

		const rawModel = params.model ?? params.options?.model;
		let resolvedModel: { provider: string; id: string } | undefined;
		if (typeof rawModel === "string") {
			const parts = rawModel.split("/");
			if (parts.length >= 2) {
				resolvedModel = { provider: parts[0], id: parts.slice(1).join("/") };
			}
		} else if (rawModel && typeof rawModel === "object") {
			resolvedModel = rawModel;
		}

		const rawThinking = params.thinkingLevel ?? params.options?.reasoningLevel ?? params.options?.thinkingLevel;
		const rawEnv = params.shellEnvOverrides ?? params.options?.envVars;

		const sessionDir = resolveSessionDir();
		const sessionFilePath = resolveSessionFilePath(providerThreadId);
		const extensionPath = requireExtensionPath();
		const scratchDir = requireScratchDir();

		const session = new PiThreadSession(
			{
				threadId,
				providerThreadId,
				cwd: params.cwd,
				sessionFilePath,
				sessionDir,
				extensionPath,
				scratchDir,
				model: resolvedModel,
				thinkingLevel: rawThinking,
				shellEnvOverrides: rawEnv,
				appendSystemPrompt: params.appendSystemPrompt,
			},
			this.sendNotification,
		);

		await session.start();
		this.sessions.set(threadId, session);

		// Send initial identity & reset boundary
		this.sendNotification("thread/identity", {
			threadId,
			providerThreadId,
			sessionRestorable: true,
		});
		this.sendNotification("thread/delta", {
			threadId,
			deltas: [{ kind: "session.reset" }],
		});

		return session;
	}

	public async reconcileCwd(threadId: string, targetCwd?: string): Promise<PiThreadSession | undefined> {
		const session = this.sessions.get(threadId);
		if (!session || !targetCwd || session.options.cwd === targetCwd) {
			return session;
		}

		// Workspace location changed, recreate session in new directory
		await session.closeGracefully();
		this.sessions.delete(threadId);

		const updatedParams = {
			...session.options,
			cwd: targetCwd,
		};
		return this.createOrGet(threadId, session.options.providerThreadId, updatedParams);
	}

	public async stop(threadId: string): Promise<void> {
		const session = this.sessions.get(threadId);
		if (session) {
			this.sessions.delete(threadId);
			await session.closeGracefully();
		}
	}

	public async stopAll(): Promise<void> {
		for (const [threadId, session] of this.sessions.entries()) {
			this.sessions.delete(threadId);
			await session.closeGracefully();
		}
	}
}
