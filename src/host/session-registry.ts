import { requireExtensionPath, requireScratchDir, resolveSessionDir, resolveSessionFilePath } from "./paths.ts";
import { parseProviderThreadId } from "./composite-id.ts";
import { PiThreadSession } from "./session.ts";
import { resolveSessionPrompts } from "./runner-prompts.ts";
import { resolveThreadContextFromDb } from "./subthread-spawner.ts";
import { extractInputText } from "./prompt-input.ts";

export interface SessionCreationParams {
	cwd?: string;
	parentThreadId?: string;
	conversationId?: string;
	input?: unknown;
	prompt?: string;
	task?: string;
	model?: unknown;
	thinkingLevel?: unknown;
	shellEnvOverrides?: NodeJS.ProcessEnv;
	providerOptions?: Record<string, unknown>;
	options?: {
		cwd?: string;
		parentThreadId?: string;
		model?: unknown;
		reasoningLevel?: unknown;
		thinkingLevel?: unknown;
		envVars?: NodeJS.ProcessEnv;
		providerOptions?: Record<string, unknown>;
		instructions?: string;
		[key: string]: unknown;
	};
	baseInstructions?: string;
	instructionMode?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	[key: string]: unknown;
}

export class SessionRegistry {
	private sendNotification: (method: string, params: Record<string, unknown>) => void;
	private sessions = new Map<string, PiThreadSession>();

	constructor(sendNotification: (method: string, params: Record<string, unknown>) => void) {
		this.sendNotification = sendNotification;
	}

	public get(threadId: string): PiThreadSession | undefined {
		const session = this.sessions.get(threadId);
		if (session && session.runner?.exited) {
			this.sessions.delete(threadId);
			return undefined;
		}
		return session;
	}

	public async createOrGet(
		threadId: string,
		providerThreadId: string,
		params: SessionCreationParams = {},
	): Promise<PiThreadSession> {
		const existing = this.sessions.get(threadId);
		if (existing && !existing.runner.exited) {
			return existing;
		}
		if (existing && existing.runner.exited) {
			this.sessions.delete(threadId);
		}

		const { sessionKey, conversationId } = parseProviderThreadId(providerThreadId);

		// Shared Owner routing: check if thread belongs to an active parent session
		const rawParent = params.parentThreadId ?? params.options?.parentThreadId;
		const parentThreadId = typeof rawParent === "string" && rawParent.trim() !== ""
			? rawParent.trim()
			: resolveThreadContextFromDb(threadId)?.parentThreadId;

		let sharedSession: PiThreadSession | undefined;
		if (parentThreadId && this.sessions.has(parentThreadId)) {
			const candidate = this.sessions.get(parentThreadId);
			if (candidate && !candidate.runner?.exited) {
				sharedSession = candidate;
			}
		}

		// Shared Owner routing: check if an active session already exists for this sessionKey
		if (!sharedSession) {
			for (const active of this.sessions.values()) {
				if (!active.runner?.exited && parseProviderThreadId(active.options.providerThreadId).sessionKey === sessionKey) {
					sharedSession = active;
					break;
				}
			}
		}

		if (sharedSession) {
			const text = extractInputText(params.input)
				|| (typeof params.prompt === "string" ? params.prompt.trim() : "")
				|| (typeof params.task === "string" ? params.task.trim() : "");

			const paramConvId = typeof params.conversationId === "string" && params.conversationId.trim() !== ""
				? params.conversationId.trim()
				: undefined;

			const existingBoundConvId = typeof (sharedSession as any).getConversationIdForThread === "function"
				? (sharedSession as any).getConversationIdForThread(threadId)
				: undefined;

			const targetConversationId = conversationId
				?? paramConvId
				?? existingBoundConvId
				?? (text && typeof sharedSession.findSubagentConversationForTask === "function"
					? sharedSession.findSubagentConversationForTask(text)
					: undefined);

			this.sessions.set(threadId, sharedSession);
			sharedSession.registerThread?.(threadId, targetConversationId);
			this.sendNotification("thread/identity", {
				threadId,
				providerThreadId,
				sessionRestorable: true,
			});
			this.sendNotification("thread/delta", {
				threadId,
				deltas: [{ kind: "session.reset" }],
			});
			return sharedSession;
		}

		const rawModel = params.model ?? params.options?.model;
		let resolvedModel: { provider: string; id: string } | undefined;
		if (typeof rawModel === "string") {
			const parts = rawModel.split("/");
			if (parts.length >= 2) {
				resolvedModel = { provider: parts[0], id: parts.slice(1).join("/") };
			}
		} else if (typeof rawModel === "object" && rawModel !== null && "provider" in rawModel && "id" in rawModel) {
			const candidate = rawModel as { provider: unknown; id: unknown };
			if (typeof candidate.provider === "string" && typeof candidate.id === "string") {
				resolvedModel = { provider: candidate.provider, id: candidate.id };
			}
		}

		const rawThinking = params.thinkingLevel ?? params.options?.reasoningLevel ?? params.options?.thinkingLevel;
		const resolvedThinking = typeof rawThinking === "string" ? rawThinking : undefined;

		const rawEnv = params.shellEnvOverrides ?? params.options?.envVars;
		let resolvedEnv: Record<string, string> | undefined;
		if (typeof rawEnv === "object" && rawEnv !== null) {
			const envObj: Record<string, string> = {};
			for (const [k, v] of Object.entries(rawEnv as Record<string, unknown>)) {
				if (typeof v === "string") envObj[k] = v;
			}
			resolvedEnv = envObj;
		}

		const rawProviderOptions = params.options?.providerOptions ?? params.providerOptions;
		const providerOptions = typeof rawProviderOptions === "object" && rawProviderOptions !== null && !Array.isArray(rawProviderOptions)
			? (rawProviderOptions as Record<string, unknown>)
			: undefined;

		const sessionDir = resolveSessionDir();
		const sessionFilePath = resolveSessionFilePath(sessionKey);
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
				thinkingLevel: resolvedThinking,
				shellEnvOverrides: resolvedEnv,
				...resolveSessionPrompts(params),
				providerOptions,
			},
			this.sendNotification,
		);

		await session.start();
		session.registerThread?.(threadId, conversationId);
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
		const session = this.get(threadId);
		if (!session) {
			return undefined;
		}
		if (!targetCwd || session.options.cwd === targetCwd) {
			return session;
		}

		// Workspace location changed, recreate session in new directory
		await session.closeGracefully();
		this.sessions.delete(threadId);

		const updatedParams: SessionCreationParams = {
			...session.options,
			cwd: targetCwd,
		};
		return this.createOrGet(threadId, session.options.providerThreadId, updatedParams);
	}

	public async stop(threadId: string): Promise<void> {
		const session = this.sessions.get(threadId);
		if (session) {
			session.unregisterThread?.(threadId);
			this.sessions.delete(threadId);
			const isStillShared = Array.from(this.sessions.values()).includes(session);
			if (!isStillShared) {
				await session.closeGracefully();
			}
		}
	}

	public async stopAll(): Promise<void> {
		const uniqueSessions = new Set(this.sessions.values());
		this.sessions.clear();
		for (const session of uniqueSessions) {
			await session.closeGracefully();
		}
	}
}
