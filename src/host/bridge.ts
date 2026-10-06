import { getSharedCatalog } from "./catalog.ts";
import { SessionRegistry } from "./session.ts";
import {
	promptInputSchema,
	PROVIDER_BRIDGE_PROTOCOL_VERSION,
	THREAD_DELTA_GRAMMAR_V2,
	THREAD_DELTA_GRAMMAR_V3,
} from "./types.ts";

export class ProviderBridge {
	private registry: SessionRegistry;

	constructor(private sendRaw: (json: string) => void) {
		this.registry = new SessionRegistry((method, params) => {
			this.sendNotification(method, params);
		});
	}

	public sendResult(id: string | number, result: any) {
		this.sendRaw(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
	}

	public sendError(id: string | number, code: number, message: string) {
		this.sendRaw(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
	}

	public sendNotification(method: string, params: any) {
		this.sendRaw(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
	}

	public async handleLine(line: string): Promise<void> {
		const trimmed = line.trim();
		if (!trimmed) return;

		let req: any;
		try {
			req = JSON.parse(trimmed);
		} catch {
			return;
		}

		if (req.method) {
			await this.handleRequest(req);
		}
	}

	private async handleRequest(req: { id: string | number; method: string; params?: any }): Promise<void> {
		const { id, method, params = {} } = req;

		try {
			switch (method) {
				case "initialize": {
					this.sendResult(id, {
						protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
						capabilities: {
							sessionRestore: true,
							threadArchive: false,
							threadRename: false,
							threadGoalClear: false,
							fork: "checkpoint",
							approvalEnforcedBy: "runtime",
							grammarVersions: [THREAD_DELTA_GRAMMAR_V2, THREAD_DELTA_GRAMMAR_V3],
							steerMode: "inject",
							skills: { configure: true },
						},
					});
					break;
				}

				case "model/list": {
					const catalog = getSharedCatalog(params.cwd);
					const models = await catalog.listModels();
					this.sendResult(id, { models, selectedOnlyModels: [] });
					break;
				}

				case "provider/health": {
					const catalog = getSharedCatalog(params.cwd);
					const health = await catalog.getHealth();
					this.sendResult(id, health);
					break;
				}

				case "provider/usage": {
					this.sendResult(id, { supported: false });
					break;
				}

				case "provider/installation/status": {
					this.sendResult(id, {
						executableName: "pi-durable",
						executablePath: process.execPath,
						installed: true,
						installSource: "external",
						currentVersion: "1.0.4",
						latestVersion: null,
						minimumSupportedVersion: "1.0.0",
						npmPackageName: "@earendil-works/pi-durable",
						npmGlobalPackageVersion: null,
						installAction: null,
						needsUpdate: false,
						versionUnsupported: false,
					});
					break;
				}

				case "provider/installation/run": {
					this.sendResult(id, {
						status: "verified",
						currentVersion: "1.0.4",
					});
					break;
				}

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
					const session = await this.registry.reconcileCwd(params.threadId, targetCwd)
						?? await this.registry.createOrGet(params.threadId, `pi_durable_${Date.now()}`, params);

					const text = this.extractInputText(params.input);
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

					const text = this.extractInputText(params.input);
					if (!text) {
						this.sendError(id, -32602, "Missing steer text");
						return;
					}

					this.sendResult(id, { threadId: params.threadId });
					await session.steer(text);
					break;
				}

				case "thread/stop": {
					await this.registry.stop(params.threadId);
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

	private extractInputText(input: unknown): string {
		const parsed = promptInputSchema.safeParse(input);
		if (!parsed.success) return "";
		return parsed.data
			.filter((chunk) => chunk.type === "text")
			.map((chunk: any) => chunk.text)
			.join("\n")
			.trim();
	}

	public async shutdown(): Promise<void> {
		await this.registry.stopAll();
		getSharedCatalog().close();
	}
}
