import type { OwnedSessionPort } from "./session-port.ts";
import { SessionCreationAbortedError } from "./session-errors.ts";
export { buildSessionOptions } from "./session-options.ts";

export interface AdmissionParticipant {
	threadId: string;
	isRoot: boolean;
	promise: Promise<OwnedSessionPort>;
	resolve: (session: OwnedSessionPort) => void;
	reject: (err: unknown) => void;
	aborted: boolean;
}

export interface InFlightAdmission {
	sessionKey: string;
	rootThreadId: string;
	creatorThreadId: string;
	participants: Map<string, AdmissionParticipant>;
	session?: OwnedSessionPort;
	aborted?: boolean;
	released?: boolean;
	isParticipantAborted(threadId: string): boolean;
}

export type AdmissionAcquisition =
	| { kind: "create"; admission: InFlightAdmission; promise: Promise<OwnedSessionPort> }
	| { kind: "wait"; promise: Promise<OwnedSessionPort>; admission: InFlightAdmission };

export class SessionAdmissionCoordinator {
	private bySessionKey = new Map<string, InFlightAdmission>();
	private byThreadId = new Map<string, InFlightAdmission>();

	public acquire(threadId: string, sessionKey: string, parentThreadId?: string): AdmissionAcquisition {
		const rootThreadId = parentThreadId ?? threadId;
		const existing = this.bySessionKey.get(sessionKey)
			?? this.byThreadId.get(threadId)
			?? (parentThreadId ? this.byThreadId.get(parentThreadId) : undefined);

		if (existing) {
			const existingPart = existing.participants.get(threadId);
			if (existingPart && !existingPart.aborted) {
				return { kind: "wait", promise: existingPart.promise, admission: existing };
			}
			let resolve!: (session: OwnedSessionPort) => void;
			let reject!: (err: unknown) => void;
			const promise = new Promise<OwnedSessionPort>((res, rej) => { resolve = res; reject = rej; });
			promise.catch(() => {});
			const participant: AdmissionParticipant = {
				threadId, isRoot: threadId === existing.rootThreadId, promise, resolve, reject, aborted: false,
			};
			existing.participants.set(threadId, participant);
			this.byThreadId.set(threadId, existing);
			return { kind: "wait", promise, admission: existing };
		}

		let resolve!: (session: OwnedSessionPort) => void;
		let reject!: (err: unknown) => void;
		const promise = new Promise<OwnedSessionPort>((res, rej) => { resolve = res; reject = rej; });
		promise.catch(() => {});
		const creatorParticipant: AdmissionParticipant = {
			threadId, isRoot: threadId === rootThreadId, promise, resolve, reject, aborted: false,
		};
		const participants = new Map<string, AdmissionParticipant>();
		participants.set(threadId, creatorParticipant);

		const admission: InFlightAdmission = {
			sessionKey, rootThreadId, creatorThreadId: threadId, participants, aborted: false,
			isParticipantAborted(tId: string) { return participants.get(tId)?.aborted ?? false; },
		};

		this.bySessionKey.set(sessionKey, admission);
		this.byThreadId.set(threadId, admission);
		if (parentThreadId && parentThreadId !== threadId) {
			this.byThreadId.set(parentThreadId, admission);
		}

		return { kind: "create", admission, promise };
	}

	public setSession(admission: InFlightAdmission, session: OwnedSessionPort): void {
		admission.session = session;
		if (admission.aborted) session.kill();
	}

	public release(admission: InFlightAdmission, session: OwnedSessionPort): void {
		admission.released = true;
		this.cleanup(admission);
		for (const p of admission.participants.values()) {
			if (p.aborted) p.reject(new SessionCreationAbortedError());
			else p.resolve(session);
		}
	}

	public reject(admission: InFlightAdmission, err: unknown): void {
		if (admission.released) return;
		this.cleanup(admission);
		if (admission.session && !admission.aborted) {
			try { admission.session.kill(); } catch {}
		}
		for (const p of admission.participants.values()) p.reject(err);
	}

	public abort(threadId: string): void {
		const admission = this.byThreadId.get(threadId);
		if (!admission) return;

		const participant = admission.participants.get(threadId);
		if (participant) {
			participant.aborted = true;
			participant.reject(new SessionCreationAbortedError());
		}
		this.byThreadId.delete(threadId);

		const isRoot = threadId === admission.rootThreadId;
		if (isRoot) {
			admission.aborted = true;
			if (admission.session) {
				try { admission.session.kill(); } catch {}
			}
			for (const [pId, p] of admission.participants) {
				if (!p.aborted) {
					p.aborted = true;
					p.reject(new SessionCreationAbortedError());
				}
				this.byThreadId.delete(pId);
			}
			this.cleanup(admission);
			return;
		}

		const hasActive = Array.from(admission.participants.values()).some((p) => !p.aborted);
		if (!hasActive) {
			admission.aborted = true;
			if (admission.session) {
				try { admission.session.kill(); } catch {}
			}
			this.cleanup(admission);
		}
	}

	public abortAll(): void {
		const admissions = new Set([...this.bySessionKey.values(), ...this.byThreadId.values()]);
		for (const admission of admissions) {
			admission.aborted = true;
			if (admission.session) {
				try { admission.session.kill(); } catch {}
			}
			for (const [pId, p] of admission.participants) {
				if (!p.aborted) {
					p.aborted = true;
					p.reject(new SessionCreationAbortedError());
				}
				this.byThreadId.delete(pId);
			}
			this.cleanup(admission);
		}
	}

	public dispose(): void { this.abortAll(); }

	private cleanup(admission: InFlightAdmission): void {
		if (this.bySessionKey.get(admission.sessionKey) === admission) {
			this.bySessionKey.delete(admission.sessionKey);
		}
		for (const pId of admission.participants.keys()) {
			if (this.byThreadId.get(pId) === admission) {
				this.byThreadId.delete(pId);
			}
		}
		if (this.byThreadId.get(admission.rootThreadId) === admission) {
			this.byThreadId.delete(admission.rootThreadId);
		}
	}
}
