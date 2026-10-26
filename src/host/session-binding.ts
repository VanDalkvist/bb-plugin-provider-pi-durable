import { parseProviderThreadId } from "./composite-id.ts";
import { SessionIdentityMismatchError } from "./session-errors.ts";
import type { OwnedSessionPort } from "./session-port.ts";

export class SessionBindingTracker {
	private boundProviderThreadIds = new Map<string, string>();

	public bind(threadId: string, providerThreadId: string): void {
		this.boundProviderThreadIds.set(threadId, providerThreadId);
	}

	public unbind(threadId: string): void {
		this.boundProviderThreadIds.delete(threadId);
	}

	public clear(): void {
		this.boundProviderThreadIds.clear();
	}

	public getBoundProviderThreadId(threadId: string): string | undefined {
		return this.boundProviderThreadIds.get(threadId);
	}

	public validateExistingThread(
		threadId: string,
		existing: OwnedSessionPort,
		requestedProviderThreadId: string,
	): void {
		const { sessionKey: requestedKey } = parseProviderThreadId(requestedProviderThreadId);
		const rootKey = parseProviderThreadId(existing.options.providerThreadId).sessionKey;
		const boundProviderId = this.boundProviderThreadIds.get(threadId) ?? existing.options.providerThreadId;
		const boundKey = parseProviderThreadId(boundProviderId).sessionKey;

		if (existing.options.threadId === threadId) {
			if (requestedKey !== rootKey) {
				throw new SessionIdentityMismatchError(
					`SESSION_IDENTITY_MISMATCH: thread ${threadId} is bound to ${rootKey}, requested ${requestedKey}`,
				);
			}
			return;
		}

		if (requestedKey === boundKey || requestedKey === rootKey) {
			return;
		}

		throw new SessionIdentityMismatchError(
			`SESSION_IDENTITY_MISMATCH: thread ${threadId} is bound to ${boundKey}, requested ${requestedKey}`,
		);
	}

	public validateChildAttachment(
		parentThreadId: string,
		candidate: OwnedSessionPort,
		requestedProviderThreadId: string,
		activeSessions: Iterable<OwnedSessionPort>,
	): void {
		const parentKey = parseProviderThreadId(candidate.options.providerThreadId).sessionKey;
		const { sessionKey: childKey, conversationId: childConvId } = parseProviderThreadId(requestedProviderThreadId);

		if (childConvId !== undefined) {
			if (childKey !== parentKey) {
				throw new SessionIdentityMismatchError(
					`SESSION_IDENTITY_MISMATCH: parent thread ${parentThreadId} is bound to ${parentKey}, requested ${childKey}`,
				);
			}
			return;
		}

		if (childKey !== parentKey) {
			for (const session of activeSessions) {
				if (!session.runner?.exited) {
					const otherRootKey = parseProviderThreadId(session.options.providerThreadId).sessionKey;
					if (otherRootKey === childKey && otherRootKey !== parentKey) {
						throw new SessionIdentityMismatchError(
							`SESSION_IDENTITY_MISMATCH: parent thread ${parentThreadId} is bound to ${parentKey}, requested ${childKey}`,
						);
					}
				}
			}
		}
	}
}
