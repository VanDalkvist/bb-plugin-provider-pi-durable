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
	public isProcessing = false;

	constructor(
		options: SessionOptions,
		sendNotification: (method: string, params: Record<string, unknown>) => void,
	) {
		this.options = options;
		this.sendNotification = sendNotification;
		this.readyPromise = new Promise((resolve) => {
			this.readyResolve = resolve;
		});

		const args = ["--mode", "rpc"];
		if (options.noSession) {
			args.push("--no-session");
		} else {
			args.push("--session", options.sessionFilePath);
		}
		args.push("--session-dir", options.sessionDir);
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
		});
	}

	public async start(): Promise<void> {
		try {
			await Promise.race([
				this.readyPromise,
				new Promise((_, reject) => setTimeout(() => reject(new Error("Runner startup ready timed out")), 20000)),
			]);
		} catch (err) {
			console.warn(`[PiThreadSession] Startup ready check timed out or failed: ${err}`);
		}

		try {
			await this.refreshContextUsage();
		} catch (err) {
			console.warn(`[PiThreadSession] Initial context refresh failed: ${err}`);
		}
	}

	private async handleRunnerEvent(event: RunnerEvent) {
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

		if (event.type === "turn_end" || event.type === "compaction_end" || event.type === "agent_end") {
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
		const res = await this.runner.requestOk({ type: "get_session_stats" });
		return res?.contextUsage ?? { tokens: null, contextWindow: 0 };
	}

	public async closeGracefully(): Promise<void> {
		await this.runner.closeGracefully();
	}

	public kill(): void {
		this.runner.kill();
	}
}
