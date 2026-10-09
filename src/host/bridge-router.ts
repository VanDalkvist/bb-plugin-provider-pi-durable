import type { SessionRegistry } from "./session-registry.ts";
import { NativeViewSession, resolveNativeViewConnection } from "./native-view-session.ts";
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

const CREQ_REGEX = /^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u;

export async function handleTurnStart(
	id: string | number,
	params: any,
	ctx: BridgeRouterContext,
): Promise<void> {
	const targetCwd = params.cwd || params.options?.cwd;
	const connection = resolveNativeViewConnection({ threadId: params.threadId, providerThreadId: params.providerThreadId,
		providerOptions: params.options?.providerOptions ?? params.providerOptions,
		environment: params.shellEnvOverrides ?? params.options?.envVars });
	const current = ctx.registry.get(params.threadId);
	const providerThreadId = connection?.expected.providerThreadId ?? params.providerThreadId ?? current?.options.providerThreadId ?? `pi_durable_${Date.now()}`;
	// Never bypass admission just because an existing session was cached.
	const session = connection || current instanceof NativeViewSession
		? await ctx.registry.createOrGet(params.threadId, providerThreadId, { ...params, cwd: targetCwd })
		: await ctx.registry.reconcileCwd(params.threadId, targetCwd)
			?? await ctx.registry.createOrGet(params.threadId, providerThreadId, params);

	if (isCompactCommand(params.input)) {
		const accepted = () => {
			if (params.clientRequestId && CREQ_REGEX.test(params.clientRequestId)) {
				ctx.sendNotification("thread/delta", {
					threadId: params.threadId,
					deltas: [{ kind: "input.accepted", clientRequestId: params.clientRequestId }],
				});
			}
		};
		const instructions = extractCompactInstructions(params.input);
		if (session instanceof NativeViewSession) {
			await session.compact(instructions);
			await session.refreshContextUsage();
			accepted();
			ctx.sendResult(id, { threadId: params.threadId });
		} else {
			accepted();
			ctx.sendResult(id, { threadId: params.threadId });
			try {
				await session.compact(instructions);
				await session.refreshContextUsage();
			} catch (err) {
				console.error(`[ProviderBridge] Compaction failed for thread ${params.threadId}:`, err);
			}
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
	params: any,
	ctx: BridgeRouterContext,
): Promise<void> {
	const session = ctx.registry.get(params?.threadId);
	if (!session) {
		ctx.sendError(id, -32000, "No active session for thread");
		return;
	}

	const providerOptions = params?.options?.providerOptions ?? params?.providerOptions;
	if (!(session instanceof NativeViewSession) && providerOptions && typeof providerOptions === "object") {
		session.options.providerOptions = {
			...session.options.providerOptions,
			...providerOptions,
		};
	}

	const text = extractInputText(params?.input);
	if (!text) {
		ctx.sendError(id, -32602, "Missing steer text");
		return;
	}

	await session.steer(text);

	if (params?.clientRequestId && CREQ_REGEX.test(params.clientRequestId)) {
		ctx.sendNotification("thread/delta", {
			threadId: params.threadId,
			deltas: [{
				kind: "input.accepted",
				clientRequestId: params.clientRequestId,
			}],
		});
	}

	ctx.sendResult(id, { threadId: params?.threadId });
}

export async function handleThreadStop(
	id: string | number,
	params: any,
	ctx: BridgeRouterContext,
): Promise<void> {
	if (params?.intent === "interrupt") {
		const session = ctx.registry.get(params.threadId);
		if (session) {
			await session.abort();
		}
		if (params?.activeTurnId) {
			ctx.sendNotification("thread/delta", {
				threadId: params.threadId,
				deltas: [{
					kind: "turn.boundary",
					providerTurnId: params.activeTurnId,
					status: "interrupted",
				}],
			});
		}
	} else {
		const session = ctx.registry.get(params?.threadId);
		try {
			if (session instanceof NativeViewSession) await session.abort();
		} finally {
			await ctx.registry.stop(params?.threadId);
		}
	}
	ctx.sendResult(id, { ok: true });
}
