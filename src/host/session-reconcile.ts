export interface ReconcilableSession {
	options: {
		model?: { provider: string; id: string };
		thinkingLevel?: string;
	};
	setModel?(provider: string, modelId: string): Promise<void>;
	setThinkingLevel?(level: string): Promise<void>;
}

export async function reconcileSessionOptions(
	session: ReconcilableSession,
	options?: { model?: unknown; reasoningLevel?: unknown; thinkingLevel?: unknown; [key: string]: unknown },
): Promise<void> {
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
