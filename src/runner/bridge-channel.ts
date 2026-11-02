import { Socket } from "node:net";
import { writeSync } from "node:fs";
import { attachJsonlLineReader } from "./jsonl.ts";
import { runnerBridgeRequestSchema } from "../contracts/runner-channel.ts";
import type { ExtensionUIDialogRequester } from "../shared/extension-ui-context.ts";

const CHILD_TO_BRIDGE_FD = 3;
const BRIDGE_TO_CHILD_FD = 4;

export function createBridgeSender(): (msg: unknown) => void {
	return (msg: unknown) => {
		const str = `${JSON.stringify(msg)}\n`;
		try {
			writeSync(CHILD_TO_BRIDGE_FD, Buffer.from(str, "utf8"));
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "EBADF" && code !== "ENXIO") {
				console.warn(`[BridgeChannel] FD ${CHILD_TO_BRIDGE_FD} write warning: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
}

interface PendingToolCall {
	resolve: (res: { content: Array<{ type: "text"; text: string }>; isError: boolean }) => void;
	timer: NodeJS.Timeout;
}

interface PendingInteraction {
	resolve: (res: unknown) => void;
	timer: NodeJS.Timeout;
}

const pendingToolCalls = new Map<string, PendingToolCall>();
const pendingInteractions = new Map<string | number, PendingInteraction>();

let nextCallSeq = 0;
export function createForwardToolCall(sendToBridge: (msg: unknown) => void) {
	return (toolName: string, args: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> => {
		const callId = `call_${Date.now()}_${++nextCallSeq}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				pendingToolCalls.delete(callId);
				resolve({ content: [{ type: "text", text: `Tool call ${toolName} timed out` }], isError: true });
			}, 120_000);
			pendingToolCalls.set(callId, { resolve, timer });
			sendToBridge({ kind: "tool_call_request", callId, toolName, arguments: args ?? {} });
		});
	};
}

let nextInteractionSeq = 0;
export function createRequestInteraction(sendToBridge: (msg: unknown) => void): ExtensionUIDialogRequester {
	return (kind, payload): Promise<unknown> => {
		const id = `interact_${Date.now()}_${++nextInteractionSeq}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				pendingInteractions.delete(id);
				resolve(null);
			}, 180_000);
			pendingInteractions.set(id, { resolve, timer });
			sendToBridge({
				kind: "interaction_request",
				id,
				interactionKind: kind,
				dialogKind: kind,
				title: payload.title,
				message: payload.message,
				data: payload.data,
			});
		});
	};
}

export function dispatchBridgeInboundFrame(
	value: unknown,
	sendToBridge?: (msg: unknown) => void,
	modelScope?: unknown,
): void {
	if (!value || typeof value !== "object") return;
	const frame = value as { kind?: string; [key: string]: unknown };

	if (frame.kind === "request" && sendToBridge) {
		const result = runnerBridgeRequestSchema.safeParse(value);
		if (!result.success) return;
		const req = result.data;
		if (req.method === "model-scope") {
			sendToBridge({ kind: "reply", id: req.id, result: modelScope });
		} else if (req.method === "refresh-models") {
			sendToBridge({ kind: "reply", id: req.id, result: { refreshed: true } });
		} else if (req.method === "leaf") {
			sendToBridge({ kind: "reply", id: req.id, result: { leafId: null } });
		} else {
			sendToBridge({ kind: "reply", id: req.id, result: {} });
		}
		return;
	}

	if (frame.kind === "tool_call_response") {
		const callId = String(frame.callId ?? "");
		const pending = pendingToolCalls.get(callId);
		if (pending) {
			clearTimeout(pending.timer);
			pendingToolCalls.delete(callId);
			let content: Array<{ type: "text"; text: string }>;
			if (Array.isArray(frame.result)) {
				content = frame.result as Array<{ type: "text"; text: string }>;
			} else if (frame.result && typeof frame.result === "object" && "content" in frame.result && Array.isArray((frame.result as { content: unknown }).content)) {
				content = (frame.result as { content: Array<{ type: "text"; text: string }> }).content;
			} else {
				content = [{ type: "text", text: typeof frame.result === "string" ? frame.result : JSON.stringify(frame.result ?? "") }];
			}
			pending.resolve({ content, isError: Boolean(frame.isError) });
		}
		return;
	}

	if (frame.kind === "interaction_response") {
		const id = (frame.id as string | number);
		const pending = pendingInteractions.get(id);
		if (pending) {
			clearTimeout(pending.timer);
			pendingInteractions.delete(id);
			pending.resolve(frame.result ?? null);
		}
	}
}

export function initBridgeInboundChannel(
	modelScope: unknown,
	sendToBridge: (msg: unknown) => void,
): void {
	try {
		const bridgeIn = new Socket({ fd: BRIDGE_TO_CHILD_FD, readable: true, writable: false });
		bridgeIn.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "EBADF") {
				console.warn(`[BridgeChannel] Inbound socket warning: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
		bridgeIn.unref();

		attachJsonlLineReader(bridgeIn, (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				const value: unknown = JSON.parse(trimmed);
				dispatchBridgeInboundFrame(value, sendToBridge, modelScope);
			} catch (err) {
				console.error(JSON.stringify({ component: "RunnerBridgeChannel", operation: "inbound_request", code: "INVALID_MESSAGE", severity: "error", outcome: "failed" }));
				bridgeIn.destroy();
			}
		});
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "EBADF") {
			console.warn(`[BridgeChannel] Inbound channel setup notice: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
