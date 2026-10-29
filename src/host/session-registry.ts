import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveSessionFilePath } from "./paths.ts";
import { parseProviderThreadId } from "./composite-id.ts";
import { PiThreadSession } from "./session.ts";
import type { OwnedSessionPort, SessionCreationParams } from "./session-port.ts";
import type { SessionOptions } from "./types.ts";
import { resolveThreadContextFromDb } from "./subthread-spawner.ts";
import { extractInputText } from "./prompt-input.ts";
import { detectNativeChild } from "./session-owner.ts";
import { SessionAdmissionCoordinator, buildSessionOptions } from "./session-admission.ts";
import { SessionCreationAbortedError, SessionOwnerConflictError, SessionIdentityMismatchError } from "./session-errors.ts";
import { SessionBindingTracker } from "./session-binding.ts";
import { parseSubagentMirrorPrompt } from "../shared/subagent-envelope.ts";

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

	private async validateMirrorTarget(session: OwnedSessionPort, threadId: string, targetConvId: string, expectedSessionKey?: string): Promise<void> {
		if (expectedSessionKey) {
			const k = parseProviderThreadId(session.options.providerThreadId).sessionKey;
			if (k !== expectedSessionKey) throw new SessionIdentityMismatchError(`SESSION_IDENTITY_MISMATCH: parent thread ${session.options.threadId} is bound to ${k}, requested ${expectedSessionKey}`);
		}
		const boundThread = session.getThreadIdForConversation?.(targetConvId);
		const boundConv = session.getConversationIdForThread?.(threadId);
		const isBoundToThis = boundThread === threadId || boundConv === targetConvId;
		if (boundThread && !isBoundToThis) throw new SessionOwnerConflictError();
		const subagentState = session.getSubagentState?.(targetConvId);
		if (!subagentState && !isBoundToThis) throw new SessionOwnerConflictError();
	}

	private async attachShared(threadId: string, providerThreadId: string, session: OwnedSessionPort, targetConvId?: string, expectedSessionKey?: string): Promise<OwnedSessionPort> {
		if (targetConvId) await this.validateMirrorTarget(session, threadId, targetConvId, expectedSessionKey);
		const sKey = parseProviderThreadId(session.options.providerThreadId).sessionKey;
		const boundProviderThreadId = targetConvId ? `${sKey}:${targetConvId}` : providerThreadId;
		this.track(threadId, session);
		this.bindings.bind(threadId, providerThreadId);
		session.registerThread?.(threadId, targetConvId);
		this.sendNotification("thread/identity", { threadId, providerThreadId: boundProviderThreadId, sessionRestorable: true });
		this.sendNotification("thread/delta", { threadId, deltas: [{ kind: "session.reset" }] });
		return session;
	}

	public async createOrGet(threadId: string, providerThreadId: string, params: SessionCreationParams = {}): Promise<OwnedSessionPort> {
		const { sessionKey, conversationId } = parseProviderThreadId(providerThreadId);

		const existing = this.sessions.get(threadId);
		if (existing) {
			if (!existing.runner?.exited) { this.bindings.validateExistingThread(threadId, existing, providerThreadId); return existing; }
			this.sessions.delete(threadId); this.bindings.unbind(threadId);
		}

		const rawParent = params.parentThreadId ?? params.options?.parentThreadId;
		const dbContext = resolveThreadContextFromDb(threadId);
		const parentThreadId = typeof rawParent === "string" && rawParent.trim() !== "" ? rawParent.trim() : dbContext?.parentThreadId;
		const rawInputText = extractInputText(params.input) || params.prompt?.trim() || params.task?.trim() || dbContext?.prompt || "";
		const parsedEnvelope = parseSubagentMirrorPrompt(rawInputText);

		let targetConvId: string | undefined;
		let effectiveParentThreadId = parentThreadId;
		let effectiveSessionKey = sessionKey;

		if (parsedEnvelope.isMirror) {
			if (parentThreadId && parentThreadId !== parsedEnvelope.parentThreadId) throw new SessionOwnerConflictError();
			effectiveParentThreadId = parsedEnvelope.parentThreadId;
			effectiveSessionKey = parsedEnvelope.sessionKey;
			targetConvId = parsedEnvelope.conversationId;
			params.prompt = parsedEnvelope.task;
			params.task = parsedEnvelope.task;
		} else {
			const paramConvId = typeof params.conversationId === "string" && params.conversationId.trim() !== "" ? params.conversationId.trim() : undefined;
			const parentPath = effectiveParentThreadId ? resolveSessionFilePath(effectiveSessionKey) : undefined;
			const native = detectNativeChild(threadId, conversationId, paramConvId, parentPath);
			if (native.isNative && native.conversationId) {
				targetConvId = native.conversationId;
			} else if (effectiveParentThreadId && this.sessions.has(effectiveParentThreadId)) {
				const bound = this.sessions.get(effectiveParentThreadId)?.getConversationIdForThread?.(threadId);
				if (bound && bound !== "1") targetConvId = bound;
			}
		}

		if (!effectiveParentThreadId) {
			for (const a of this.sessions.values()) {
				if (!a.runner?.exited && parseProviderThreadId(a.options.providerThreadId).sessionKey === effectiveSessionKey) {
					effectiveParentThreadId = a.options.threadId; break;
				}
			}
		}

		if (targetConvId && targetConvId !== "1") {
			if (!effectiveParentThreadId) throw new Error(`Unresolved parent owner thread for subagent conversation ${targetConvId}`);
			const expectedSessionKey = parsedEnvelope.isMirror ? parsedEnvelope.sessionKey : undefined;
			let sharedSession: OwnedSessionPort | undefined;
			if (this.sessions.has(effectiveParentThreadId)) {
				const candidate = this.sessions.get(effectiveParentThreadId);
				if (candidate && !candidate.runner?.exited) {
					this.bindings.validateChildAttachment(effectiveParentThreadId, candidate, providerThreadId, this.sessions.values());
					await this.validateMirrorTarget(candidate, threadId, targetConvId, expectedSessionKey);
					sharedSession = candidate;
				}
			}

			if (sharedSession) {
				return await this.attachShared(threadId, providerThreadId, sharedSession, targetConvId, expectedSessionKey);
			}

			const acquisition = this.admission.acquire(threadId, effectiveSessionKey, effectiveParentThreadId);
			if (acquisition.kind === "wait") {
				const created = await acquisition.promise;
				if (this.sessions.get(threadId) === created) return created;
				return await this.attachShared(threadId, providerThreadId, created, targetConvId, expectedSessionKey);
			}

			const sessionDbPath = join(resolveSessionFilePath(effectiveSessionKey), "session.sqlite");
			if (!existsSync(sessionDbPath)) {
				this.admission.reject(acquisition.admission, new SessionOwnerConflictError());
				throw new SessionOwnerConflictError();
			}

			const { admission } = acquisition;
			try {
				const options = buildSessionOptions(effectiveParentThreadId, providerThreadId, effectiveSessionKey, params, this.sharedSkillRoots, true);
				const session = this.sessionFactory(options, this.sendNotification);
				this.admission.setSession(admission, session);
				await session.start();
				if (admission.aborted) {
					session.kill();
					this.admission.reject(admission, new SessionCreationAbortedError());
					throw new SessionCreationAbortedError();
				}
				this.track(effectiveParentThreadId, session);
				session.registerThread?.(effectiveParentThreadId);
				const childAborted = admission.isParticipantAborted(threadId);
				if (!childAborted) await this.attachShared(threadId, providerThreadId, session, targetConvId, expectedSessionKey);
				this.admission.release(admission, session);
				if (childAborted) throw new SessionCreationAbortedError();
				return session;
			} catch (err) {
				if (!admission.released) this.admission.reject(admission, err);
				throw err;
			}
		}

		const acquisition = this.admission.acquire(threadId, sessionKey, undefined);
		if (acquisition.kind === "wait") return acquisition.promise;

		const { admission } = acquisition;
		try {
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
			if (!creatorAborted) await this.attachShared(threadId, providerThreadId, session, conversationId);
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
