import type { SessionRegistry } from "./session-registry.ts";
import {
	extractInputText,
	isCompactCommand,
	extractCompactInstructions,
} from "./prompt-input.ts";

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
	options?: {
		cwd?: string;
		[key: string]: unknown;
	};
	clientRequestId?: string;
	input?: unknown;
	[key: string]: unknown;
}

export interface TurnSteerParams {
	threadId: string;
	clientRequestId?: string;
	expectedTurnId?: string;
	input?: unknown;
	options?: {
		providerOptions?: Record<string, unknown>;
		[key: string]: unknown;
	};
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

const CREQ_REGEX = /^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u;

export async function handleTurnStart(
	id: string | number,
	params: TurnStartParams,
	ctx: BridgeRouterContext,
): Promise<void> {
	const targetCwd = params.cwd || params.options?.cwd;
	const providerThreadId = params.providerThreadId || `pi_durable_${Date.now()}`;
	const session = await ctx.registry.reconcileCwd(params.threadId, targetCwd)
		?? await ctx.registry.createOrGet(params.threadId, providerThreadId, params);

	if (isCompactCommand(params.input)) {
		if (params.clientRequestId && CREQ_REGEX.test(params.clientRequestId)) {
			ctx.sendNotification("thread/delta", {
				threadId: params.threadId,
				deltas: [{ kind: "input.accepted", clientRequestId: params.clientRequestId }],
			});
		}
		ctx.sendResult(id, { threadId: params.threadId });
		const instructions = extractCompactInstructions(params.input);
		try {
			await session.compact(instructions);
			await session.refreshContextUsage();
		} catch (err) {
			console.error(`[ProviderBridge] Compaction failed for thread ${params.threadId}:`, err);
		}
		return;
	}

	const text = extractInputText(params.input);
	if (!text) {
		ctx.sendError(id, -32602, "Missing input text");
		return;
	}

	await session.prompt(text);

	if (params.clientRequestId && CREQ_REGEX.test(params.clientRequestId)) {
		ctx.sendNotification("thread/delta", {
			threadId: params.threadId,
			deltas: [{ kind: "input.accepted", clientRequestId: params.clientRequestId }],
		});
	}

	ctx.sendResult(id, { threadId: params.threadId });
}

export async function handleTurnSteer(
	id: string | number,
	params: TurnSteerParams,
	ctx: BridgeRouterContext,
): Promise<void> {
	const session = ctx.registry.get(params.threadId);
	if (!session) {
		ctx.sendError(id, -32000, "No active session for thread");
		return;
	}

	const providerOptions = params.options?.providerOptions ?? params.providerOptions;
	if (providerOptions && typeof providerOptions === "object") {
		session.options.providerOptions = {
			...session.options.providerOptions,
			...providerOptions,
		};
	}

	const text = extractInputText(params.input);
	if (!text) {
		ctx.sendError(id, -32602, "Missing steer text");
		return;
	}

	await session.steer(text);

	if (params.clientRequestId && CREQ_REGEX.test(params.clientRequestId)) {
		ctx.sendNotification("thread/delta", {
			threadId: params.threadId,
			deltas: [{
				kind: "input.accepted",
				clientRequestId: params.clientRequestId,
			}],
		});
	}

	ctx.sendResult(id, { threadId: params.threadId });
}

export async function handleThreadStop(
	id: string | number,
	params: ThreadStopParams,
	ctx: BridgeRouterContext,
): Promise<void> {
	if (params.intent === "interrupt") {
		const session = ctx.registry.get(params.threadId);
		if (session) {
			ctx.sendNotification("thread/delta", {
				threadId: params.threadId,
				deltas: [{ kind: "session.ended" }],
			});
			await session.abort();
		}
		const checkpointId = session?.getLastCheckpointId() ?? null;
		ctx.sendResult(id, { ok: true, providerCheckpointId: checkpointId });
	} else {
		await ctx.registry.stop(params.threadId);
		ctx.sendResult(id, { ok: true });
	}
}
