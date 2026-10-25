import { parseProviderThreadId } from "./composite-id.ts";

export interface ChildTurnSessionLike {
	options?: { threadId?: string; model?: { provider: string; id: string }; thinkingLevel?: string };
	getSubagentState?: (convId: string | number) => import("./subagent-mirror.ts").SubagentMirrorRecord | undefined;
	getConversationIdForThread?: (threadId: string) => string | undefined;
	runner?: { requestOk: (cmd: Record<string, unknown>) => Promise<any> };
}

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
	if (params.providerThreadId) {
		const parsed = parseProviderThreadId(params.providerThreadId).conversationId;
		if (parsed) return parsed;
	}
	const bound = session.getConversationIdForThread?.(params.threadId);
	if (bound) return bound;
	if (!session.options?.threadId || params.threadId === session.options.threadId) {
		return parseProviderThreadId(session.options?.providerThreadId ?? params.threadId).conversationId;
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
		if (parsed.conversationId) return true;
	}
	if (session?.options?.threadId && params.threadId !== session.options.threadId) {
		return true;
	}
	const parent = params.parentThreadId ?? params.options?.parentThreadId;
	if (typeof parent === "string" && parent.trim() !== "") {
		return true;
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
	if (!targetConversationId) return { valid: true };

	let mirror = session.getSubagentState?.(targetConversationId);
	let actualModel = mirror?.actualModel;
	let thinkingLevel = mirror?.thinkingLevel;

	if (!actualModel && session.runner?.requestOk) {
		try {
			const res = await session.runner.requestOk({ type: "get_state", conversationId: targetConversationId });
			const agentDoc = (res as any)?.state?.agent ?? (res as any)?.agent;
			if (agentDoc?.model?.provider && (agentDoc?.model?.id || agentDoc?.model?.modelId)) {
				actualModel = {
					provider: agentDoc.model.provider,
					modelId: agentDoc.model.id || agentDoc.model.modelId,
				};
			}
			if (typeof agentDoc?.thinkingLevel === "string") {
				thinkingLevel = agentDoc.thinkingLevel;
			}
		} catch {
			// Non-fatal if state fetch fails; fall back to root/defaults
		}
	}

	const reqModel = parseModelRef(params.options?.model);
	if (reqModel && actualModel) {
		if (reqModel.provider !== actualModel.provider || reqModel.modelId !== actualModel.modelId) {
			return {
				valid: false,
				code: -32602,
				message: `CHILD_MODEL_POLICY_LOCKED: Subagent child thread model (${actualModel.provider}/${actualModel.modelId}) cannot be overridden with (${reqModel.provider}/${reqModel.modelId})`,
			};
		}
	}

	const reqThinking = normalizeThinkingLevel(params.options?.reasoningLevel ?? params.options?.thinkingLevel);
	const actThinking = normalizeThinkingLevel(thinkingLevel);
	if (reqThinking !== undefined && actThinking !== undefined) {
		if (reqThinking !== actThinking) {
			return {
				valid: false,
				code: -32602,
				message: `CHILD_MODEL_POLICY_LOCKED: Subagent child thread thinking level (${actThinking}) cannot be overridden with (${reqThinking})`,
			};
		}
	}

	return { valid: true };
}
