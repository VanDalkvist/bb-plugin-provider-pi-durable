export interface InteractionRequestParams {
	threadId?: string;
	providerThreadId: string;
	turnId?: string | null;
	kind: "select" | "confirm" | "input" | "editor" | "notify";
	title?: string;
	message?: string;
	data?: unknown;
	scope: string;
	timeoutMs?: number;
}

interface PendingInteraction {
	id: string | number;
	scope: string;
	timer: NodeJS.Timeout;
	resolve: (res: unknown) => void;
}

export class PendingInteractionTracker {
	private nextId = 1;
	private pending = new Map<string | number, PendingInteraction>();
	private sendMessage: (msg: Record<string, unknown>) => void;

	constructor(sendMessage: (msg: Record<string, unknown>) => void) {
		this.sendMessage = sendMessage;
	}

	public requestInteraction(params: InteractionRequestParams): Promise<unknown> {
		const reqId = this.nextId++;
		const timeoutMs = params.timeoutMs ?? 180_000;

		return new Promise<unknown>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(reqId);
				resolve(null);
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
				method: "interaction/request",
				params: {
					threadId: params.threadId,
					providerThreadId: params.providerThreadId,
					turnId: params.turnId ?? null,
					payload: {
						kind: params.kind,
						title: params.title,
						message: params.message,
						data: params.data,
					},
				},
			});
		});
	}

	public handleInteractionResponse(response: { id?: string | number; result?: unknown; error?: unknown }): boolean {
		if (response.id === undefined || response.id === null) return false;
		const pendingCall = this.pending.get(response.id);
		if (!pendingCall) return false;

		clearTimeout(pendingCall.timer);
		this.pending.delete(response.id);

		if (response.error) {
			pendingCall.resolve(null);
			return true;
		}

		pendingCall.resolve(response.result ?? null);
		return true;
	}

	public resolvePendingInteractions(scope: string, _reason?: string): void {
		for (const [id, call] of this.pending.entries()) {
			if (call.scope === scope) {
				clearTimeout(call.timer);
				this.pending.delete(id);
				call.resolve(null);
			}
		}
	}

	public dispose(): void {
		for (const [id, call] of this.pending.entries()) {
			clearTimeout(call.timer);
			this.pending.delete(id);
			call.resolve(null);
		}
	}
}
