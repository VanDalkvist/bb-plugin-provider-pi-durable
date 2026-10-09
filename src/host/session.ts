import { RunnerProcess } from "./runner-process.ts";
import { DeltaTranslator } from "./delta-translator.ts";
import {
	buildRunnerArgs,
	createReadyDeferred,
	waitForReady,
	extractSessionStats,
	createContextWindowDelta,
	type SessionStats,
} from "./session-telemetry.ts";
import type { RunnerEvent, SessionOptions } from "./types.ts";

export class PiThreadSession {
	public options: SessionOptions;
	private sendNotification: (method: string, params: Record<string, unknown>) => void;
	public runner: RunnerProcess;
	public translator = new DeltaTranslator();
	public readyPromise: Promise<void>;
	private readyResolve: () => void;
	private readyReject: (err: Error) => void;
	public isProcessing = false;

	constructor(
		options: SessionOptions,
		sendNotification: (method: string, params: Record<string, unknown>) => void,
	) {
		this.options = options;
		this.sendNotification = sendNotification;

		const deferred = createReadyDeferred();
		this.readyPromise = deferred.promise;
		this.readyResolve = deferred.resolve;
		this.readyReject = deferred.reject;

		this.runner = new RunnerProcess({
			cwd: options.cwd || process.cwd(),
			args: buildRunnerArgs(options),
			env: options.shellEnvOverrides,
			onEvent: (event) => this.handleRunnerEvent(event),
			onChannelMessage: (msg: any) => {
				if (msg?.kind === "ready") this.readyResolve();
			},
			onError: (err) => this.readyReject(new Error(`Runner failed to launch: ${err.message}`)),
			onExit: (code, sig) => this.readyReject(new Error(`Runner exited before becoming ready (code ${code}, signal ${sig})`)),
		});
	}

	public get exited(): boolean { return this.runner.exited; }

	public async start(): Promise<void> {
		try {
			await waitForReady(this.readyPromise);
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
			providerOptions: this.options.providerOptions,
		});
		if (deltas.length > 0) {
			this.sendNotification("thread/delta", { threadId: this.options.threadId, deltas });
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
			await this.runner.requestOk({ type: "prompt", message: text, streamingBehavior: "followUp" });
		} finally {
			this.isProcessing = false;
		}
	}

	public async steer(text: string): Promise<void> {
		await this.runner.requestOk({ type: "steer", message: text });
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
			await this.runner.requestOk({ type: "compact", instructions });
		} finally {
			this.isProcessing = false;
		}
	}

	public async refreshContextUsage(): Promise<void> {
		const stats = await this.getSessionStats();
		const delta = createContextWindowDelta(stats);
		if (delta) {
			this.sendNotification("thread/delta", { threadId: this.options.threadId, deltas: [delta] });
		}
	}

	public async getSessionStats(): Promise<SessionStats> {
		const res = await this.runner.requestOk({ type: "get_session_stats" });
		return extractSessionStats(res);
	}

	public async closeGracefully(): Promise<void> {
		await this.runner.closeGracefully();
	}

	public kill(): void {
		this.runner.kill();
	}
}
