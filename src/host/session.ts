import { RunnerProcess } from "./runner-process.ts";
import { DeltaTranslator } from "./delta-translator.ts";
import type { RunnerEvent, SessionOptions } from "./types.ts";

export class PiThreadSession {
	public options: SessionOptions;
	private sendNotification: (method: string, params: Record<string, unknown>) => void;
	public runner: RunnerProcess;
	public translator = new DeltaTranslator();
	public readyPromise: Promise<void>;
	private readyResolve!: () => void;
	private readyReject!: (err: Error) => void;
	private startupSettled = false;
	public isProcessing = false;

	constructor(
		options: SessionOptions,
		sendNotification: (method: string, params: Record<string, unknown>) => void,
	) {
		this.options = options;
		this.sendNotification = sendNotification;
		this.readyPromise = new Promise((resolve, reject) => {
			this.readyResolve = () => {
				if (!this.startupSettled) {
					this.startupSettled = true;
					resolve();
				}
			};
			this.readyReject = (err: Error) => {
				if (!this.startupSettled) {
					this.startupSettled = true;
					reject(err);
				}
			};
		});
		// intentionally ignored: prevent unhandledRejection if readyPromise rejects before caller awaits start()
		this.readyPromise.catch(() => {});

		const args = ["--mode", "rpc"];
		if (options.noSession) {
			args.push("--no-session");
		} else {
			args.push("--session", options.sessionFilePath);
		}
		args.push("--extension", options.extensionPath);

		if (options.model) {
			args.push("--provider", options.model.provider, "--model", options.model.id);
		}
		if (options.thinkingLevel) {
			args.push("--thinking", options.thinkingLevel);
		}
		if (options.appendSystemPrompt) {
			args.push("--append-system-prompt", options.appendSystemPrompt);
		}

		this.runner = new RunnerProcess({
			cwd: options.cwd || process.cwd(),
			args,
			env: options.shellEnvOverrides,
			onEvent: (event) => this.handleRunnerEvent(event),
			onChannelMessage: (msg: any) => {
				if (msg?.kind === "ready") {
					this.readyResolve();
				}
			},
			onError: (err) => {
				this.readyReject(new Error(`Runner failed to launch: ${err.message}`));
			},
			onExit: (code, signal) => {
				this.readyReject(new Error(`Runner exited before becoming ready (code ${code}, signal ${signal})`));
			},
		});
	}

	public async start(): Promise<void> {
		let timer: NodeJS.Timeout | null = null;
		try {
			try {
				await Promise.race([
					this.readyPromise,
					new Promise<void>((_, reject) => {
						timer = setTimeout(() => reject(new Error("Runner startup ready timed out")), 20000);
					}),
				]);
			} finally {
				if (timer !== null) {
					clearTimeout(timer);
				}
			}

			await this.refreshContextUsage();
		} catch (err) {
			this.kill();
			throw err;
		}
	}

	private async handleRunnerEvent(event: RunnerEvent) {
		if (event.type === "agent_end") {
			try {
				await this.refreshContextUsage();
			} catch (err) {
				console.warn(`[PiThreadSession] Context refresh failed before agent_end: ${err}`);
			}
		}

		const deltas = this.translator.translate(event, {
			threadId: this.options.threadId,
			cwd: this.options.cwd,
		});
		if (deltas.length > 0) {
			this.sendNotification("thread/delta", {
				threadId: this.options.threadId,
				deltas,
			});
		}

		if (event.type === "turn_end" || event.type === "compaction_end") {
			try {
				await this.refreshContextUsage();
			} catch (err) {
				console.warn(`[PiThreadSession] Context refresh failed after ${event.type}: ${err}`);
			}
		}
	}

	public async prompt(text: string): Promise<void> {
		this.isProcessing = true;
		try {
			await this.runner.requestOk({
				type: "prompt",
				message: text,
				streamingBehavior: "followUp",
			});
		} finally {
			this.isProcessing = false;
		}
	}

	public async steer(text: string): Promise<void> {
		await this.runner.requestOk({
			type: "steer",
			message: text,
		});
	}

	public async abort(): Promise<void> {
		try {
			await this.runner.requestOk({ type: "abort" });
		} catch (err) {
			console.warn(`[PiThreadSession] Abort request failed: ${err}`);
		}
	}

	public async compact(instructions?: string): Promise<void> {
		this.isProcessing = true;
		try {
			await this.runner.requestOk({
				type: "compact",
				instructions,
			});
		} finally {
			this.isProcessing = false;
		}
	}

	public async refreshContextUsage(): Promise<void> {
		const stats = await this.getSessionStats();
		if (stats && typeof stats.contextWindow === "number" && stats.contextWindow > 0) {
			this.sendNotification("thread/delta", {
				threadId: this.options.threadId,
				deltas: [
					{
						kind: "contextWindow",
						used: stats.tokens,
						size: stats.contextWindow,
						estimated: true,
						attach: "currentOrLast",
					},
				],
			});
		}
	}

	public async getSessionStats(): Promise<{ tokens: number | null; contextWindow: number }> {
		const res = (await this.runner.requestOk({ type: "get_session_stats" })) as any;
		const usage = res?.contextUsage ?? res?.data?.contextUsage ?? res;
		return {
			tokens: typeof usage?.tokens === "number" ? usage.tokens : null,
			contextWindow: typeof usage?.contextWindow === "number" ? usage.contextWindow : 0,
		};
	}

	public async closeGracefully(): Promise<void> {
		await this.runner.closeGracefully();
	}

	public kill(): void {
		this.runner.kill();
	}
}
