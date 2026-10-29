import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { parseProviderThreadId } from "./composite-id.ts";
import { SessionIdentityMismatchError } from "./session-errors.ts";

export interface ChildTurnSessionLike {
	options?: { threadId?: string; model?: { provider: string; id: string }; thinkingLevel?: string };
	getSubagentState?: (convId: string | number) => import("./subagent-mirror.ts").SubagentMirrorRecord | undefined;
	getConversationIdForThread?: (threadId: string) => string | undefined;
	runner?: { requestOk: (cmd: Record<string, unknown>) => Promise<unknown> };
}

const ROOT_CONVERSATION_ID_STR = String(ROOT_CONVERSATION_ID);
const CREQ_REGEX = /^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u;

export function sendInputAccepted(
	sendNotification: (method: string, params: Record<string, unknown>) => void,
	threadId: string,
	clientRequestId?: string,
): void {
	if (clientRequestId && CREQ_REGEX.test(clientRequestId)) {
		sendNotification("thread/delta", { threadId, deltas: [{ kind: "input.accepted", clientRequestId }] });
	}
}

export function resolveTargetConversationId(
	params: { threadId: string; providerThreadId?: string },
	session: { options?: { threadId?: string; providerThreadId?: string }; getConversationIdForThread?: (t: string) => string | undefined },
): string | undefined {
	const bound = session.getConversationIdForThread?.(params.threadId);
	if (params.providerThreadId) {
		const parsed = parseProviderThreadId(params.providerThreadId).conversationId;
		if (parsed && parsed !== ROOT_CONVERSATION_ID_STR) {
			if (bound && bound !== ROOT_CONVERSATION_ID_STR && parsed !== bound) {
				throw new SessionIdentityMismatchError(
					`SESSION_IDENTITY_MISMATCH: thread ${params.threadId} is bound to conversation ${bound}, requested ${parsed}`,
				);
			}
			return parsed;
		}
	}
	if (bound && bound !== ROOT_CONVERSATION_ID_STR) return bound;
	if (!session.options?.threadId || params.threadId === session.options.threadId) {
		const parsed = parseProviderThreadId(session.options?.providerThreadId ?? params.threadId).conversationId;
		if (parsed && parsed !== ROOT_CONVERSATION_ID_STR) return parsed;
	}
	return undefined;
}

export function synthesizeCompletionDeltas(outputText?: string): import("./types.ts").ThreadDelta[] {
	const deltas: Array<import("./types.ts").ThreadDelta> = [{ kind: "turn.open" }];
	if (outputText) {
		deltas.push(
			{ kind: "item.textDelta", key: { channel: "agentMessage" }, channel: "agentMessage", text: outputText },
			{ kind: "item.textClose", key: { channel: "agentMessage" }, channel: "agentMessage", text: outputText },
		);
	}
	deltas.push({ kind: "turn.boundary", status: "completed" });
	return deltas;
}

export function isChildTurn(
	params: { threadId: string; providerThreadId?: string; parentThreadId?: string; options?: { parentThreadId?: string; [key: string]: unknown } },
	session?: ChildTurnSessionLike,
): boolean {
	if (params.providerThreadId) {
		const parsed = parseProviderThreadId(params.providerThreadId);
		if (parsed.conversationId && parsed.conversationId !== ROOT_CONVERSATION_ID_STR) return true;
	}
	if (session?.options?.threadId && params.threadId !== session.options.threadId) {
		return true;
	}
	if (session?.getConversationIdForThread) {
		const bound = session.getConversationIdForThread(params.threadId);
		if (bound && bound !== ROOT_CONVERSATION_ID_STR) return true;
	}
	if (session?.options?.threadId && session.options.threadId === params.threadId) {
		return false;
	}
	return false;
}

export function normalizeThinkingLevel(level?: unknown): string | undefined {
	if (typeof level !== "string") return undefined;
	const trimmed = level.trim();
	if (trimmed === "none" || trimmed === "off") return "off";
	return trimmed;
}

export function parseModelRef(raw: unknown): { provider: string; modelId: string } | undefined {
	if (typeof raw === "string" && raw.trim()) {
		const slash = raw.indexOf("/");
		if (slash !== -1) {
			return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
		}
	} else if (typeof raw === "object" && raw !== null) {
		const m = raw as { provider?: unknown; id?: unknown; modelId?: unknown };
		const p = typeof m.provider === "string" ? m.provider : undefined;
		const id = typeof m.id === "string" ? m.id : (typeof m.modelId === "string" ? m.modelId : undefined);
		if (p && id) return { provider: p, modelId: id };
	}
	return undefined;
}

export async function validateChildTurn(
	params: { threadId: string; options?: { model?: unknown; reasoningLevel?: unknown; thinkingLevel?: unknown } },
	session: ChildTurnSessionLike,
	targetConversationId?: string,
): Promise<{ valid: true } | { valid: false; code: number; message: string }> {
	if (!targetConversationId || targetConversationId === ROOT_CONVERSATION_ID_STR) return { valid: true };

	const mirror = session.getSubagentState?.(targetConversationId);
	let actualModel = mirror?.actualModel;
	let thinkingLevel = mirror?.thinkingLevel;

	if ((!actualModel || thinkingLevel === undefined) && session.runner?.requestOk) {
		try {
			const raw = await session.runner.requestOk({ type: "get_state", conversationId: targetConversationId });
			const payload = ((raw as Record<string, unknown>)?.data ?? raw) as Record<string, unknown> | undefined;
			if (payload?.model && typeof payload.model === "object") {
				const m = payload.model as Record<string, unknown>;
				if (typeof m.provider === "string" && (typeof m.modelId === "string" || typeof m.id === "string")) {
					actualModel = {
						provider: m.provider,
						modelId: (m.modelId ?? m.id) as string,
					};
				}
			}
			if (typeof payload?.thinkingLevel === "string") {
				thinkingLevel = payload.thinkingLevel;
			}
		} catch {
			// Handled by fail-closed checks below
		}
	}

	const reqModel = parseModelRef(params.options?.model);
	if (reqModel) {
		if (!actualModel) {
			return {
				valid: false,
				code: -32602,
				message: "CHILD_MODEL_POLICY_LOCKED: Could not resolve subagent child thread model to validate requested model override",
			};
		}
		if (reqModel.provider !== actualModel.provider || reqModel.modelId !== actualModel.modelId) {
			return {
				valid: false,
				code: -32602,
				message: `CHILD_MODEL_POLICY_LOCKED: Subagent child thread model (${actualModel.provider}/${actualModel.modelId}) cannot be overridden with (${reqModel.provider}/${reqModel.modelId})`,
			};
		}
	}

	const reqThinking = normalizeThinkingLevel(params.options?.reasoningLevel ?? params.options?.thinkingLevel);
	if (reqThinking !== undefined) {
		if (thinkingLevel === undefined) {
			return {
				valid: false,
				code: -32602,
				message: "CHILD_MODEL_POLICY_LOCKED: Could not resolve subagent child thread thinking level to validate requested thinking override",
			};
		}
		const actThinking = normalizeThinkingLevel(thinkingLevel);
		if (reqThinking !== actThinking) {
			return {
				valid: false,
				code: -32602,
				message: `CHILD_MODEL_POLICY_LOCKED: Subagent child thread thinking level (${actThinking ?? thinkingLevel}) cannot be overridden with (${reqThinking})`,
			};
		}
	}

	return { valid: true };
}
