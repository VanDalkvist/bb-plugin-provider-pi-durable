import { requireExtensionPath, requireScratchDir, resolveSessionDir, resolveSessionFilePath } from "./paths.ts";
import { parseProviderThreadId } from "./composite-id.ts";
import { PiThreadSession } from "./session.ts";
import { resolveSessionPrompts } from "./runner-prompts.ts";
import { resolveThreadContextFromDb } from "./subthread-spawner.ts";
import { extractInputText } from "./prompt-input.ts";
import { detectNativeChild } from "./session-owner.ts";

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
	private sharedSkillRoots: string[] = [];

	public getSharedSkillRoots(): readonly string[] { return this.sharedSkillRoots; }
	public setSharedSkillRoots(roots: readonly string[]): void { this.sharedSkillRoots = [...roots]; }

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
		if (existing && !existing.runner.exited) return existing;
		if (existing && existing.runner.exited) this.sessions.delete(threadId);

		const { sessionKey, conversationId } = parseProviderThreadId(providerThreadId);
		const rawParent = params.parentThreadId ?? params.options?.parentThreadId;
		const parentThreadId = typeof rawParent === "string" && rawParent.trim() !== ""
			? rawParent.trim()
			: resolveThreadContextFromDb(threadId)?.parentThreadId;

		const paramConvId = typeof params.conversationId === "string" && params.conversationId.trim() !== "" ? params.conversationId.trim() : undefined;
		const parentSessionFilePath = parentThreadId ? resolveSessionFilePath(sessionKey) : undefined;
		const nativeChild = detectNativeChild(threadId, conversationId, paramConvId, parentSessionFilePath);

		let sharedSession: PiThreadSession | undefined;
		if (parentThreadId && this.sessions.has(parentThreadId)) {
			const candidate = this.sessions.get(parentThreadId);
			if (candidate && !candidate.runner?.exited) {
				const text = extractInputText(params.input) || (typeof params.prompt === "string" ? params.prompt.trim() : "") || (typeof params.task === "string" ? params.task.trim() : "");
				const taskConvId = text && typeof candidate.findSubagentConversationForTask === "function" ? candidate.findSubagentConversationForTask(text) : undefined;
				const boundConvId = candidate.getConversationIdForThread?.(threadId);
				if (nativeChild.isNative || taskConvId !== undefined || boundConvId !== undefined) {
					sharedSession = candidate;
				}
			}
		}

		if (!sharedSession) {
			for (const active of this.sessions.values()) {
				if (!active.runner?.exited && parseProviderThreadId(active.options.providerThreadId).sessionKey === sessionKey) {
					if (nativeChild.isNative || active.options.threadId === threadId) {
						sharedSession = active;
						break;
					}
				}
			}
		}

		if (sharedSession) {
			const text = extractInputText(params.input) || (typeof params.prompt === "string" ? params.prompt.trim() : "") || (typeof params.task === "string" ? params.task.trim() : "");
			const targetConvId = nativeChild.conversationId ?? (text && typeof sharedSession.findSubagentConversationForTask === "function" ? sharedSession.findSubagentConversationForTask(text) : undefined) ?? sharedSession.getConversationIdForThread?.(threadId);
			this.sessions.set(threadId, sharedSession);
			sharedSession.registerThread?.(threadId, targetConvId);
			this.sendNotification("thread/identity", { threadId, providerThreadId, sessionRestorable: true });
			this.sendNotification("thread/delta", { threadId, deltas: [{ kind: "session.reset" }] });
			return sharedSession;
		}

		const sessionDir = resolveSessionDir(), sessionFilePath = resolveSessionFilePath(sessionKey), extensionPath = requireExtensionPath(), scratchDir = requireScratchDir();
		const rawSkills = (params.additionalSkillPaths as string[]) ?? ((params.options as any)?.additionalSkillPaths as string[]);
		const skillRoots = Array.from(new Set([...(rawSkills ?? []), ...this.sharedSkillRoots]));
		const rawEnv = params.shellEnvOverrides ?? params.options?.envVars;
		const resolvedEnv = typeof rawEnv === "object" && rawEnv !== null
			? Object.fromEntries(Object.entries(rawEnv as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
			: undefined;
		const rawProviderOptions = params.options?.providerOptions ?? params.providerOptions;
		const providerOptions = typeof rawProviderOptions === "object" && rawProviderOptions !== null && !Array.isArray(rawProviderOptions) ? (rawProviderOptions as Record<string, unknown>) : undefined;

		if (nativeChild.isNative) {
			if (!parentThreadId) {
				throw new Error(`Unresolved parent owner thread for subagent conversation ${nativeChild.conversationId}`);
			}
			const session = new PiThreadSession({
				threadId: parentThreadId, providerThreadId: sessionKey, cwd: params.cwd, sessionFilePath, sessionDir, extensionPath, scratchDir,
				model: undefined, thinkingLevel: undefined, shellEnvOverrides: resolvedEnv,
				...resolveSessionPrompts(params), providerOptions, ...(skillRoots.length > 0 ? { additionalSkillPaths: skillRoots } : {}),
			}, this.sendNotification);

			await session.start();
			this.sessions.set(parentThreadId, session);
			this.sessions.set(threadId, session);
			session.registerThread?.(parentThreadId);
			session.registerThread?.(threadId, nativeChild.conversationId);
			this.sendNotification("thread/identity", { threadId, providerThreadId, sessionRestorable: true });
			this.sendNotification("thread/delta", { threadId, deltas: [{ kind: "session.reset" }] });
			return session;
		}

		const rawModel = params.model ?? params.options?.model;
		let resolvedModel: { provider: string; id: string } | undefined;
		if (typeof rawModel === "string") {
			const parts = rawModel.split("/");
			if (parts.length >= 2) resolvedModel = { provider: parts[0], id: parts.slice(1).join("/") };
		} else if (typeof rawModel === "object" && rawModel !== null && "provider" in rawModel && "id" in rawModel) {
			const cand = rawModel as { provider: unknown; id: unknown };
			if (typeof cand.provider === "string" && typeof cand.id === "string") resolvedModel = { provider: cand.provider, id: cand.id };
		}

		const rawThinking = params.thinkingLevel ?? params.options?.reasoningLevel ?? params.options?.thinkingLevel;
		const resolvedThinking = typeof rawThinking === "string" ? rawThinking : undefined;

		const session = new PiThreadSession({
			threadId, providerThreadId, cwd: params.cwd, sessionFilePath, sessionDir, extensionPath, scratchDir,
			model: resolvedModel, thinkingLevel: resolvedThinking, shellEnvOverrides: resolvedEnv,
			...resolveSessionPrompts(params), providerOptions, ...(skillRoots.length > 0 ? { additionalSkillPaths: skillRoots } : {}),
		}, this.sendNotification);

		await session.start();
		session.registerThread?.(threadId, conversationId);
		this.sessions.set(threadId, session);
		this.sendNotification("thread/identity", { threadId, providerThreadId, sessionRestorable: true });
		this.sendNotification("thread/delta", { threadId, deltas: [{ kind: "session.reset" }] });
		return session;
	}

	public async reconcileCwd(threadId: string, targetCwd?: string): Promise<PiThreadSession | undefined> {
		const session = this.get(threadId);
		if (!session || !targetCwd || session.options.cwd === targetCwd) return session;
		await session.closeGracefully();
		this.sessions.delete(threadId);
		return this.createOrGet(threadId, session.options.providerThreadId, { ...session.options, cwd: targetCwd });
	}

	public async stop(threadId: string): Promise<void> {
		const session = this.sessions.get(threadId);
		if (session) {
			session.unregisterThread?.(threadId);
			this.sessions.delete(threadId);
			if (!Array.from(this.sessions.values()).includes(session)) await session.closeGracefully();
		}
	}

	public async stopAll(): Promise<void> {
		const uniqueSessions = new Set(this.sessions.values());
		this.sessions.clear();
		for (const session of uniqueSessions) await session.closeGracefully();
	}
}
