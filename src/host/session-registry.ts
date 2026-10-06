import { requireExtensionPath, requireScratchDir, resolveSessionDir, resolveSessionFilePath } from "./paths.ts";
import { PiThreadSession } from "./session.ts";

export class SessionRegistry {
	private sendNotification: (method: string, params: Record<string, unknown>) => void;
	private sessions = new Map<string, PiThreadSession>();

	constructor(sendNotification: (method: string, params: Record<string, unknown>) => void) {
		this.sendNotification = sendNotification;
	}

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
