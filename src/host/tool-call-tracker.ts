import type { ToolCallForwardResult } from "./types.ts";
import { bbToolCallResponseSchema } from "./bb-tools.ts";

export interface ForwardToolCallParams {
	threadId?: string;
	providerThreadId: string;
	turnId?: string | null;
	toolName: string;
	arguments?: unknown;
	scope: string;
	timeoutMs?: number;
}

interface PendingCall {
	id: string | number;
	scope: string;
	timer: NodeJS.Timeout;
	resolve: (res: ToolCallForwardResult) => void;
}

export class PendingToolCallTracker {
	private nextId = 1;
	private pending = new Map<string | number, PendingCall>();
	private sendMessage: (msg: Record<string, unknown>) => void;

	constructor(sendMessage: (msg: Record<string, unknown>) => void) {
		this.sendMessage = sendMessage;
	}

	public forwardToolCall(params: ForwardToolCallParams): Promise<ToolCallForwardResult> {
		const reqId = this.nextId++;
		const timeoutMs = params.timeoutMs ?? 120_000;

		return new Promise<ToolCallForwardResult>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(reqId);
				resolve({
					content: [{ type: "text", text: `Tool call timed out after ${timeoutMs}ms` }],
					isError: true,
				});
			}, timeoutMs);

			this.pending.set(reqId, {
				id: reqId,
				scope: params.scope,
				timer,
				resolve,
			});

			this.sendMessage({
				jsonrpc: "2.0",
				id: reqId,
				method: "item/tool/call",
				params: {
					threadId: params.threadId,
					providerThreadId: params.providerThreadId,
					turnId: params.turnId ?? null,
					callId: `call_${reqId}`,
					tool: params.toolName,
					arguments: params.arguments ?? {},
				},
			});
		});
	}

	public handleToolCallResponse(response: { id?: string | number; result?: unknown; error?: unknown; [key: string]: unknown }): boolean {
		if (response.id === undefined || response.id === null) return false;
		const pendingCall = this.pending.get(response.id);
		if (!pendingCall) return false;

		clearTimeout(pendingCall.timer);
		this.pending.delete(response.id);

		if (response.error) {
			const errObj = response.error as { message?: string };
			const errMsg = errObj?.message ?? JSON.stringify(response.error);
			pendingCall.resolve({
				content: [{ type: "text", text: errMsg }],
				isError: true,
			});
			return true;
		}

		const parsed = bbToolCallResponseSchema.safeParse(response.result);
		if (parsed.success) {
			const isError = Boolean(parsed.data.isError || parsed.data.error);
			const items = parsed.data.contentItems.map((item) => ({
				type: "text" as const,
				text: item.type === "inputText" ? item.text : `[image: ${item.imageUrl}]`,
			}));
			pendingCall.resolve({
				content: items.length > 0 ? items : [{ type: "text", text: "" }],
				isError,
			});
			return true;
		}

		const text = typeof response.result === "string" ? response.result : JSON.stringify(response.result ?? "");
		pendingCall.resolve({
			content: [{ type: "text", text }],
			isError: false,
		});
		return true;
	}

	public resolvePendingToolCalls(scope: string, reason: string): void {
		for (const [id, call] of this.pending.entries()) {
			if (call.scope === scope) {
				clearTimeout(call.timer);
				this.pending.delete(id);
				call.resolve({
					content: [{ type: "text", text: `Tool call cancelled: ${reason}` }],
					isError: true,
				});
			}
		}
	}

	public dispose(reason = "Tracker disposed"): void {
		for (const [id, call] of this.pending.entries()) {
			clearTimeout(call.timer);
			this.pending.delete(id);
			call.resolve({
				content: [{ type: "text", text: reason }],
				isError: true,
			});
		}
	}
}
