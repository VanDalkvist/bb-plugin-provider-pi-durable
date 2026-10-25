import type { SubagentPolicyRecord } from "../policy/types.ts";
import { subagentPolicyRecordSchema } from "../policy/schema.ts";

export interface ReconcilableSession {
	options: {
		model?: { provider: string; id: string };
		thinkingLevel?: string;
		providerOptions?: Record<string, unknown>;
	};
	setModel?(provider: string, modelId: string): Promise<void>;
	setThinkingLevel?(level: string): Promise<void>;
	setSubagentPolicy?(record: SubagentPolicyRecord): Promise<void>;
	getAcknowledgedSubagentPolicyRevision?(): number | undefined;
}

export async function reconcileSessionOptions(
	session: ReconcilableSession,
	options?: {
		model?: unknown;
		reasoningLevel?: unknown;
		thinkingLevel?: unknown;
		providerOptions?: Record<string, unknown>;
		[key: string]: unknown;
	},
	fallbackProviderOptions?: Record<string, unknown>,
): Promise<void> {
	const rawPolicy =
		(options?.providerOptions as Record<string, unknown> | undefined)?.subagentPolicy ??
		(fallbackProviderOptions as Record<string, unknown> | undefined)?.subagentPolicy ??
		(session.options?.providerOptions as Record<string, unknown> | undefined)?.subagentPolicy;

	if (rawPolicy && session.setSubagentPolicy) {
		const parsed = subagentPolicyRecordSchema.safeParse(rawPolicy);
		if (parsed.success) {
			const ackRev = session.getAcknowledgedSubagentPolicyRevision?.();
			if (ackRev === undefined || ackRev !== parsed.data.revision) {
				await session.setSubagentPolicy(parsed.data);
			}
		}
	}

	if (!options) return;

	const optModel = options.model;
	if (typeof optModel === "string" && optModel.trim()) {
		const slash = optModel.indexOf("/");
		const provider = slash !== -1 ? optModel.slice(0, slash) : undefined;
		const id = slash !== -1 ? optModel.slice(slash + 1) : optModel;
		if (provider && (session.options.model?.provider !== provider || session.options.model?.id !== id)) {
			await session.setModel?.(provider, id);
		}
	} else if (typeof optModel === "object" && optModel !== null) {
		const m = optModel as { provider?: string; id?: string; modelId?: string };
		const modelId = m.id ?? m.modelId;
		if (m.provider && modelId && (session.options.model?.provider !== m.provider || session.options.model?.id !== modelId)) {
			await session.setModel?.(m.provider, modelId);
		}
	}
	const optThinking = options.reasoningLevel ?? options.thinkingLevel;
	if (typeof optThinking === "string" && optThinking && optThinking !== session.options.thinkingLevel) {
		await session.setThinkingLevel?.(optThinking);
	}
}
