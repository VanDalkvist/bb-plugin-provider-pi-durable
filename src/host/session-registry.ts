import { resolveSessionFilePath } from "./paths.ts";
import { parseProviderThreadId } from "./composite-id.ts";
import { PiThreadSession } from "./session.ts";
import type { OwnedSessionPort, SessionCreationParams } from "./session-port.ts";
import type { SessionOptions } from "./types.ts";
import { resolveThreadContextFromDb } from "./subthread-spawner.ts";
import { extractInputText } from "./prompt-input.ts";
import { detectNativeChild } from "./session-owner.ts";
import { SessionAdmissionCoordinator, buildSessionOptions } from "./session-admission.ts";
import { SessionCreationAbortedError, SessionOwnerConflictError } from "./session-errors.ts";
import { SessionBindingTracker } from "./session-binding.ts";

export type SessionFactory = (options: SessionOptions, sendNotification: (method: string, params: Record<string, unknown>) => void) => OwnedSessionPort;

export class SessionRegistry {
	private sendNotification: (method: string, params: Record<string, unknown>) => void;
	private sessions = new Map<string, OwnedSessionPort>();
	private bindings = new SessionBindingTracker();
	private sharedSkillRoots: string[] = [];
	private admission = new SessionAdmissionCoordinator();
	private sessionFactory: SessionFactory;

	public getSharedSkillRoots(): readonly string[] { return this.sharedSkillRoots; }
	public setSharedSkillRoots(roots: readonly string[]): void { this.sharedSkillRoots = [...roots]; }
	public getBoundProviderThreadId(threadId: string): string | undefined { return this.bindings.getBoundProviderThreadId(threadId); }

	constructor(sendNotification: (method: string, params: Record<string, unknown>) => void, sessionFactory?: SessionFactory) {
		this.sendNotification = sendNotification;
		this.sessionFactory = sessionFactory ?? ((options, notify) => new PiThreadSession(options, notify));
	}

	public track(threadId: string, session: OwnedSessionPort): void {
		const existing = this.sessions.get(threadId);
		if (existing && existing !== session) throw new SessionOwnerConflictError();
		this.sessions.set(threadId, session);
		if (!this.bindings.getBoundProviderThreadId(threadId)) this.bindings.bind(threadId, session.options.providerThreadId);
	}

	public get(threadId: string): OwnedSessionPort | undefined {
		const session = this.sessions.get(threadId);
		if (session && session.runner?.exited) {
			this.sessions.delete(threadId);
			this.bindings.unbind(threadId);
			return undefined;
		}
		return session;
	}

	private attachShared(threadId: string, providerThreadId: string, session: OwnedSessionPort, nativeChild: ReturnType<typeof detectNativeChild>, params: SessionCreationParams, parentThreadId?: string): OwnedSessionPort {
		const text = extractInputText(params.input) || params.prompt?.trim() || params.task?.trim() || "";
		const targetConvId = nativeChild.conversationId ?? (text && typeof session.findSubagentConversationForTask === "function" ? session.findSubagentConversationForTask(text) : undefined) ?? session.getConversationIdForThread?.(threadId);
		if (parentThreadId && !targetConvId) {
			throw new Error(`Cannot resolve native child conversation for thread ${threadId} under parent ${parentThreadId}`);
		}
		this.track(threadId, session);
		this.bindings.bind(threadId, providerThreadId);
		session.registerThread?.(threadId, targetConvId);
		this.sendNotification("thread/identity", { threadId, providerThreadId, sessionRestorable: true });
		this.sendNotification("thread/delta", { threadId, deltas: [{ kind: "session.reset" }] });
		return session;
	}

	public async createOrGet(threadId: string, providerThreadId: string, params: SessionCreationParams = {}): Promise<OwnedSessionPort> {
		const { sessionKey, conversationId } = parseProviderThreadId(providerThreadId);

		const existing = this.sessions.get(threadId);
		if (existing && !existing.runner?.exited) {
			this.bindings.validateExistingThread(threadId, existing, providerThreadId);
			return existing;
		}
		if (existing && existing.runner?.exited) { this.sessions.delete(threadId); this.bindings.unbind(threadId); }

		const rawParent = params.parentThreadId ?? params.options?.parentThreadId;
		const parentThreadId = typeof rawParent === "string" && rawParent.trim() !== "" ? rawParent.trim() : resolveThreadContextFromDb(threadId)?.parentThreadId;
		const paramConvId = typeof params.conversationId === "string" && params.conversationId.trim() !== "" ? params.conversationId.trim() : undefined;
		const parentSessionFilePath = parentThreadId ? resolveSessionFilePath(sessionKey) : undefined;
		const nativeChild = detectNativeChild(threadId, conversationId, paramConvId, parentSessionFilePath);

		let sharedSession: OwnedSessionPort | undefined;
		if (parentThreadId && this.sessions.has(parentThreadId)) {
			const candidate = this.sessions.get(parentThreadId);
			if (candidate && !candidate.runner?.exited) {
				this.bindings.validateChildAttachment(parentThreadId, candidate, providerThreadId, this.sessions.values());
				const text = extractInputText(params.input) || params.prompt?.trim() || params.task?.trim() || "";
				const taskConvId = text && typeof candidate.findSubagentConversationForTask === "function" ? candidate.findSubagentConversationForTask(text) : undefined;
				const boundConvId = candidate.getConversationIdForThread?.(threadId);
				if (nativeChild.isNative || taskConvId !== undefined || boundConvId !== undefined) sharedSession = candidate;
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

		if (sharedSession) return this.attachShared(threadId, providerThreadId, sharedSession, nativeChild, params, parentThreadId);

		const acquisition = this.admission.acquire(threadId, sessionKey, parentThreadId);
		if (acquisition.kind === "wait") {
			const created = await acquisition.promise;
			if (this.sessions.get(threadId) === created) return created;
			return this.attachShared(threadId, providerThreadId, created, nativeChild, params, parentThreadId);
		}

		const { admission } = acquisition;
		try {
			if (nativeChild.isNative || parentThreadId) {
				if (!parentThreadId) throw new Error(`Unresolved parent owner thread for subagent conversation ${nativeChild.conversationId}`);
				const options = buildSessionOptions(parentThreadId, providerThreadId, sessionKey, params, this.sharedSkillRoots, true);
				const session = this.sessionFactory(options, this.sendNotification);
				this.admission.setSession(admission, session);
				await session.start();
				if (admission.aborted) {
					session.kill();
					this.admission.reject(admission, new SessionCreationAbortedError());
					throw new SessionCreationAbortedError();
				}
				this.track(parentThreadId, session);
				session.registerThread?.(parentThreadId);
				const childAborted = admission.isParticipantAborted(threadId);
				if (!childAborted) {
					const resolvedConvId = nativeChild.conversationId ?? session.getConversationIdForThread?.(threadId);
					if (!resolvedConvId) {
						throw new Error(`Cannot resolve native child conversation for thread ${threadId} under parent ${parentThreadId}`);
					}
					this.track(threadId, session);
					this.bindings.bind(threadId, providerThreadId);
					session.registerThread?.(threadId, resolvedConvId);
					this.sendNotification("thread/identity", { threadId, providerThreadId, sessionRestorable: true });
					this.sendNotification("thread/delta", { threadId, deltas: [{ kind: "session.reset" }] });
				}
				this.admission.release(admission, session);
				if (childAborted) throw new SessionCreationAbortedError();
				return session;
			}

			const options = buildSessionOptions(threadId, providerThreadId, sessionKey, params, this.sharedSkillRoots, false);
			const session = this.sessionFactory(options, this.sendNotification);
			this.admission.setSession(admission, session);
			await session.start();
			if (admission.aborted) {
				session.kill();
				this.admission.reject(admission, new SessionCreationAbortedError());
				throw new SessionCreationAbortedError();
			}
			const creatorAborted = admission.isParticipantAborted(threadId);
			if (!creatorAborted) {
				session.registerThread?.(threadId, conversationId);
				this.track(threadId, session);
				this.bindings.bind(threadId, providerThreadId);
				this.sendNotification("thread/identity", { threadId, providerThreadId, sessionRestorable: true });
				this.sendNotification("thread/delta", { threadId, deltas: [{ kind: "session.reset" }] });
			}
			this.admission.release(admission, session);
			if (creatorAborted) throw new SessionCreationAbortedError();
			return session;
		} catch (err) {
			if (!admission.released) this.admission.reject(admission, err);
			throw err;
		}
	}

	public async reconcileCwd(threadId: string, targetCwd?: string): Promise<OwnedSessionPort | undefined> {
		const session = this.get(threadId);
		if (!session || !targetCwd || session.options.cwd === targetCwd) return session;
		await session.closeGracefully();
		this.sessions.delete(threadId);
		this.bindings.unbind(threadId);
		return this.createOrGet(threadId, session.options.providerThreadId, { ...session.options, cwd: targetCwd });
	}

	public async stop(threadId: string): Promise<void> {
		this.admission.abort(threadId);
		this.bindings.unbind(threadId);
		const session = this.sessions.get(threadId);
		if (session) {
			session.unregisterThread?.(threadId);
			this.sessions.delete(threadId);
			if (!Array.from(this.sessions.values()).includes(session)) await session.closeGracefully();
		}
	}

	public async stopAll(): Promise<void> {
		this.admission.abortAll();
		this.bindings.clear();
		const uniqueSessions = new Set(this.sessions.values());
		this.sessions.clear();
		for (const session of uniqueSessions) await session.closeGracefully();
	}

	public dispose(): Promise<void> { return this.stopAll(); }
}
