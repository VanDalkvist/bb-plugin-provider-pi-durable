import { getSharedCatalog } from "./catalog.ts";
import { SessionRegistry } from "./session-registry.ts";
import { handleDiscoveryRequest } from "./discovery-handler.ts";
import {
	sendJsonRpcResult,
	sendJsonRpcError,
	sendJsonRpcNotification,
} from "./jsonrpc.ts";
import {
	extractInputText,
	isCompactCommand,
	extractCompactInstructions,
} from "./prompt-input.ts";

export class ProviderBridge {
	private sendRaw: (json: string) => void;
	private registry: SessionRegistry;

	constructor(sendRaw: (json: string) => void) {
		this.sendRaw = sendRaw;
		this.registry = new SessionRegistry((method, params) => {
			this.sendNotification(method, params);
		});
	}

	public sendResult(id: string | number, result: Record<string, unknown>) {
		sendJsonRpcResult(this.sendRaw, id, result);
	}

	public sendError(id: string | number, code: number, message: string) {
		sendJsonRpcError(this.sendRaw, id, code, message);
	}

	public sendNotification(method: string, params: Record<string, unknown>) {
		sendJsonRpcNotification(this.sendRaw, method, params);
	}

	public async handleLine(line: string): Promise<void> {
		const trimmed = line.trim();
		if (!trimmed) return;

		let req: { id?: string | number; method?: string; params?: any };
		try {
			req = JSON.parse(trimmed);
		} catch (err) {
			console.error(`[ProviderBridge] Invalid JSON received from daemon: ${trimmed}`, err);
			this.sendError(0, -32700, "Parse error: Invalid JSON");
			return;
		}

		if (req && typeof req.method === "string") {
			await this.handleRequest(req as { id: string | number; method: string; params?: any });
		}
	}

	private async handleRequest(req: { id: string | number; method: string; params?: any }): Promise<void> {
		const { id, method, params = {} } = req;

		try {
			const discoveryResult = await handleDiscoveryRequest(method, params, getSharedCatalog(params.cwd));
			if (discoveryResult !== null) {
				this.sendResult(id, discoveryResult);
				return;
			}

			switch (method) {
				case "thread/start":
				case "thread/resume": {
					const threadId = params.threadId;
					const providerThreadId = params.providerThreadId || `pi_durable_${Date.now()}`;
					await this.registry.createOrGet(threadId, providerThreadId, params);
					this.sendResult(id, {
						providerThreadId,
						sessionRestorable: true,
					});
					break;
				}

				case "thread/fork": {
					const threadId = params.threadId;
					const providerThreadId = `pi_durable_${Date.now()}`;
					await this.registry.createOrGet(threadId, providerThreadId, params);
					this.sendResult(id, {
						providerThreadId,
						sessionRestorable: true,
					});
					break;
				}

				case "turn/start": {
					const targetCwd = params.cwd || params.options?.cwd;
					const providerThreadId = params.providerThreadId || `pi_durable_${Date.now()}`;
					const session = await this.registry.reconcileCwd(params.threadId, targetCwd)
						?? await this.registry.createOrGet(params.threadId, providerThreadId, params);

					if (isCompactCommand(params.input)) {
						if (params.clientRequestId && /^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u.test(params.clientRequestId)) {
							this.sendNotification("thread/delta", {
								threadId: params.threadId,
								deltas: [{ kind: "input.accepted", clientRequestId: params.clientRequestId }],
							});
						}
						this.sendResult(id, { threadId: params.threadId });
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
						this.sendError(id, -32602, "Missing input text");
						return;
					}

					// 1. Submit prompt to runner
					await session.prompt(text);

					// 2. Notify input accepted (if clientRequestId is a valid creq_ token)
					if (params.clientRequestId && /^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u.test(params.clientRequestId)) {
						this.sendNotification("thread/delta", {
							threadId: params.threadId,
							deltas: [{ kind: "input.accepted", clientRequestId: params.clientRequestId }],
						});
					}

					// 3. Respond to turn/start immediately to allow client and daemon to track turn
					this.sendResult(id, { threadId: params.threadId });
					break;
				}

				case "turn/steer": {
					const session = this.registry.get(params.threadId);
					if (!session) {
						this.sendError(id, -32000, "No active session for thread");
						return;
					}

					const text = extractInputText(params.input);
					if (!text) {
						this.sendError(id, -32602, "Missing steer text");
						return;
					}

					await session.steer(text);

					if (params.clientRequestId && /^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u.test(params.clientRequestId)) {
						this.sendNotification("thread/delta", {
							threadId: params.threadId,
							deltas: [{
								kind: "input.accepted",
								clientRequestId: params.clientRequestId,
								providerTurnId: params.expectedTurnId,
							}],
						});
					}

					this.sendResult(id, { threadId: params.threadId });
					break;
				}

				case "thread/stop": {
					if (params.intent === "interrupt") {
						const session = this.registry.get(params.threadId);
						if (session) {
							await session.abort();
						}
						if (params.activeTurnId) {
							this.sendNotification("thread/delta", {
								threadId: params.threadId,
								deltas: [{
									kind: "turn.boundary",
									providerTurnId: params.activeTurnId,
									status: "interrupted",
								}],
							});
						}
					} else {
						await this.registry.stop(params.threadId);
					}
					this.sendResult(id, { ok: true });
					break;
				}

				case "thread/discard": {
					await this.registry.stop(params.threadId);
					this.sendResult(id, { ok: true });
					break;
				}

				case "skills/configure": {
					this.sendResult(id, { ok: true });
					break;
				}

				default:
					this.sendError(id, -32601, `Method not found: ${method}`);
					break;
			}
		} catch (err: any) {
			this.sendError(id, -32000, err.message || String(err));
		}
	}

	public async shutdown(): Promise<void> {
		await this.registry.stopAll();
		getSharedCatalog().close();
	}
}
