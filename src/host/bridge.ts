import { getSharedCatalog } from "./catalog.ts";
import { SessionRegistry } from "./session-registry.ts";
import { resolveNativeViewConnection } from "./native-view-session.ts";
import { handleDiscoveryRequest } from "./discovery-handler.ts";
import {
	sendJsonRpcResult,
	sendJsonRpcError,
	sendJsonRpcNotification,
} from "./jsonrpc.ts";
import {
	handleTurnStart,
	handleTurnSteer,
	handleThreadStop,
	type BridgeRouterContext,
} from "./bridge-router.ts";

export class ProviderBridge {
	private sendRaw: (json: string) => void;
	private registry: SessionRegistry;

	constructor(sendRaw: (json: string) => void, dependencies: {
		createRegistry?: (notify: (method: string, params: Record<string, unknown>) => void) => SessionRegistry;
	} = {}) {
		this.sendRaw = sendRaw;
		const notify = (method: string, params: Record<string, unknown>) => this.sendNotification(method, params);
		this.registry = dependencies.createRegistry?.(notify) ?? new SessionRegistry(notify);
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

	private get routerContext(): BridgeRouterContext {
		return {
			registry: this.registry,
			sendNotification: (m, p) => this.sendNotification(m, p),
			sendResult: (i, r) => this.sendResult(i, r),
			sendError: (i, c, m) => this.sendError(i, c, m),
		};
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
					const connection = resolveNativeViewConnection({ threadId, providerThreadId: params.providerThreadId, providerOptions: params.options?.providerOptions ?? params.providerOptions, environment: params.shellEnvOverrides ?? params.options?.envVars });
					const providerThreadId = connection?.expected.providerThreadId ?? params.providerThreadId ?? `pi_durable_${Date.now()}`;
					await this.registry.createOrGet(threadId, providerThreadId, params);
					this.sendResult(id, { providerThreadId, sessionRestorable: true });
					break;
				}

				case "thread/fork": {
					const threadId = params.threadId;
					const connection = resolveNativeViewConnection({ threadId, providerOptions: params.options?.providerOptions ?? params.providerOptions, environment: params.shellEnvOverrides ?? params.options?.envVars });
					// A new native SID has no source transcript. Never advertise an empty view as a fork.
					if (connection) throw new Error("Native Durable fork unsupported: source transcript identity is not preserved");
					const providerThreadId = `pi_durable_${Date.now()}`;
					await this.registry.createOrGet(threadId, providerThreadId, params);
					this.sendResult(id, { providerThreadId, sessionRestorable: true });
					break;
				}

				case "turn/start": {
					await handleTurnStart(id, params, this.routerContext);
					break;
				}

				case "turn/steer": {
					await handleTurnSteer(id, params, this.routerContext);
					break;
				}

				case "thread/stop": {
					await handleThreadStop(id, params, this.routerContext);
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
