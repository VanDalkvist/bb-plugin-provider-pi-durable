import type { SessionRegistry } from "./session-registry.ts";
import { extractPiPromptInput, isCompactCommand, extractCompactInstructions } from "./prompt-input.ts";
import { reconcileSessionOptions } from "./session-reconcile.ts";
import { isChildTurn, validateChildTurn, sendInputAccepted, resolveTargetConversationId, synthesizeCompletionDeltas } from "./child-turn-guard.ts";

export interface BridgeRouterContext {
	registry: SessionRegistry;
	sendNotification: (method: string, params: Record<string, unknown>) => void;
	sendResult: (id: string | number, result: Record<string, unknown>) => void;
	sendError: (id: string | number, code: number, message: string) => void;
}

export interface TurnStartParams {
	threadId: string;
	providerThreadId?: string;
	cwd?: string;
	options?: { cwd?: string; model?: unknown; reasoningLevel?: unknown; thinkingLevel?: unknown; providerOptions?: Record<string, unknown>; [key: string]: unknown };
	providerOptions?: Record<string, unknown>;
	clientRequestId?: string;
	input?: unknown;
	[key: string]: unknown;
}

export interface TurnSteerParams {
	threadId: string;
	providerThreadId?: string;
	clientRequestId?: string;
	expectedTurnId?: string;
	input?: unknown;
	options?: { model?: unknown; reasoningLevel?: unknown; thinkingLevel?: unknown; providerOptions?: Record<string, unknown>; [key: string]: unknown };
	providerOptions?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface ThreadStopParams {
	threadId: string;
	providerThreadId?: string;
	intent?: "interrupt" | "release";
	activeTurnId?: string;
	[key: string]: unknown;
}

export async function handleTurnStart(id: string | number, params: TurnStartParams, ctx: BridgeRouterContext): Promise<void> {
	const existing = ctx.registry.get(params.threadId);
	const isChild = isChildTurn(params, existing);

	if (isChild) {
		if (isCompactCommand(params.input)) {
			ctx.sendError(id, -32602, "Context compaction is not supported on child subagent thread");
			return;
		}
		const providerThreadId = params.providerThreadId || `pi_durable_${Date.now()}`;
		const session = await ctx.registry.createOrGet(params.threadId, providerThreadId, params);
		const promptInput = extractPiPromptInput(params.input);
		if (!promptInput) {
			ctx.sendError(id, -32602, "Missing input text");
			return;
		}
		const { text, images } = promptInput;
		const targetConversationId = resolveTargetConversationId(params, session)
			?? (typeof session.findSubagentConversationForTask === "function" ? session.findSubagentConversationForTask(text) : undefined);

		const validation = await validateChildTurn(params, session, targetConversationId);
		if (!validation.valid) {
			ctx.sendError(id, validation.code, validation.message);
			return;
		}

		const mirror = targetConversationId && typeof session.getSubagentState === "function" ? session.getSubagentState(targetConversationId) : undefined;
		const isInitial = mirror !== undefined && !mirror.initialTurnConsumed && mirror.task.trim() !== "" &&
			(mirror.task.trim() === text.trim() || mirror.task.trim().startsWith(text.trim()) || text.trim().startsWith(mirror.task.trim()));

		if (isInitial && mirror?.status === "running") {
			mirror.initialTurnConsumed = true;
			session.registerThread?.(params.threadId, targetConversationId);
			sendInputAccepted(ctx.sendNotification, params.threadId, params.clientRequestId);
			ctx.sendNotification("thread/delta", { threadId: params.threadId, deltas: [{ kind: "turn.open" }] });
			ctx.sendResult(id, { threadId: params.threadId });
			return;
		}
		if (isInitial && mirror?.status === "completed") {
			mirror.initialTurnConsumed = true;
			let boundaryEmitted = false;
			const originalSend = ctx.sendNotification;
			ctx.sendNotification = (method, p) => {
				if (method === "thread/delta" && p?.threadId === params.threadId && Array.isArray(p.deltas)) {
					if (p.deltas.some((d: any) => d.kind === "turn.boundary")) {
						boundaryEmitted = true;
					}
				}
				originalSend(method, p);
			};
			try {
				session.registerThread?.(params.threadId, targetConversationId);
			} finally {
				ctx.sendNotification = originalSend;
			}

			const outputText = typeof session.getMirrorOutputText === "function" && targetConversationId ? session.getMirrorOutputText(targetConversationId) : (mirror.result || "");
			if (typeof session.consumeCompletedMirror === "function" && targetConversationId) session.consumeCompletedMirror(targetConversationId);
			sendInputAccepted(ctx.sendNotification, params.threadId, params.clientRequestId);
			ctx.sendResult(id, { threadId: params.threadId });

			if (!boundaryEmitted) {
				ctx.sendNotification("thread/delta", { threadId: params.threadId, deltas: synthesizeCompletionDeltas(outputText) });
			}
			return;
		}

		await session.prompt(text, images.length > 0 ? images : targetConversationId, images.length > 0 ? targetConversationId : undefined);
		sendInputAccepted(ctx.sendNotification, params.threadId, params.clientRequestId);
		ctx.sendResult(id, { threadId: params.threadId });
		return;
	}

	const targetCwd = params.cwd || params.options?.cwd;
	const providerThreadId = params.providerThreadId || `pi_durable_${Date.now()}`;
	const session = await ctx.registry.reconcileCwd(params.threadId, targetCwd) ?? await ctx.registry.createOrGet(params.threadId, providerThreadId, params);

	if (isCompactCommand(params.input)) {
		sendInputAccepted(ctx.sendNotification, params.threadId, params.clientRequestId);
		ctx.sendResult(id, { threadId: params.threadId });
		try {
			await session.compact(extractCompactInstructions(params.input));
			await session.refreshContextUsage();
		} catch (err) {
			console.error(`[ProviderBridge] Compaction failed for thread ${params.threadId}:`, err);
		}
		return;
	}

	const promptInput = extractPiPromptInput(params.input);
	if (!promptInput) {
		ctx.sendError(id, -32602, "Missing input text");
		return;
	}
	const { text, images } = promptInput;

	await reconcileSessionOptions(session, params.options, params.providerOptions);
	await session.prompt(text, images.length > 0 ? images : undefined, undefined);
	sendInputAccepted(ctx.sendNotification, params.threadId, params.clientRequestId);
	ctx.sendResult(id, { threadId: params.threadId });
}

export async function handleTurnSteer(id: string | number, params: TurnSteerParams, ctx: BridgeRouterContext): Promise<void> {
	const session = ctx.registry.get(params.threadId);
	if (!session) {
		ctx.sendError(id, -32000, "No active session for thread");
		return;
	}

	const isChild = isChildTurn(params, session);
	const promptInput = extractPiPromptInput(params.input);
	if (!promptInput) {
		ctx.sendError(id, -32602, "Missing steer text");
		return;
	}
	const { text, images } = promptInput;

	if (isChild) {
		const targetConversationId = resolveTargetConversationId(params, session);
		const validation = await validateChildTurn(params, session, targetConversationId);
		if (!validation.valid) {
			ctx.sendError(id, validation.code, validation.message);
			return;
		}
		await session.steer(text, images.length > 0 ? images : targetConversationId, images.length > 0 ? targetConversationId : undefined);
		sendInputAccepted(ctx.sendNotification, params.threadId, params.clientRequestId);
		ctx.sendResult(id, { threadId: params.threadId });
		return;
	}

	const providerOptions = params.options?.providerOptions ?? params.providerOptions;
	if (providerOptions && typeof providerOptions === "object") {
		session.options.providerOptions = { ...session.options.providerOptions, ...providerOptions };
	}

	await reconcileSessionOptions(session, params.options, params.providerOptions);
	await session.steer(text, images.length > 0 ? images : undefined, undefined);
	sendInputAccepted(ctx.sendNotification, params.threadId, params.clientRequestId);
	ctx.sendResult(id, { threadId: params.threadId });
}

export async function handleThreadStop(id: string | number, params: ThreadStopParams, ctx: BridgeRouterContext): Promise<void> {
	if (params.intent === "interrupt") {
		const session = ctx.registry.get(params.threadId);
		if (session) {
			ctx.sendNotification("thread/delta", { threadId: params.threadId, deltas: [{ kind: "session.ended" }] });
			await session.abort(resolveTargetConversationId(params, session));
		}
		ctx.sendResult(id, { ok: true, providerCheckpointId: session?.getLastCheckpointId() ?? null });
	} else {
		await ctx.registry.stop(params.threadId);
		ctx.sendResult(id, { ok: true });
	}
}
