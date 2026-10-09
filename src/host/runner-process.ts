import { spawn } from "node:child_process";
import { resolveRunnerPath } from "./paths.ts";
import { RunnerRpcChannel } from "./runner-rpc-channel.ts";
import type { RunnerEvent } from "./types.ts";

export type RunnerProcessExit =
	| { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
	| { kind: "spawn-failure"; code: null; signal: null; error: Error };

type RunnerChildProcess = {
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "spawn", listener: () => void): unknown;
	on(event: "exit" | "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	stdin: { end(): void; write(data: string): boolean } | null;
	stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
	stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
	stdio: Array<NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined>;
	kill(signal?: NodeJS.Signals): boolean;
};

export interface RunnerProcessOptions {
	cwd: string;
	args: string[];
	env?: Record<string, string>;
	runnerPath?: string;
	onEvent?: (event: RunnerEvent) => void;
	onChannelMessage?: (msg: unknown) => void;
	onError?: (err: Error) => void;
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
	spawnProcess?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => RunnerChildProcess;
}

export class RunnerProcess {
	private options: RunnerProcessOptions;
	private child: RunnerChildProcess;
	private channel = new RunnerRpcChannel();
	private observedExitResolve!: (exit: RunnerProcessExit) => void;
	private observedTermination = false;
	private spawnObserved = false;
	private spawnFailed = false;
	public readonly observedExit = new Promise<RunnerProcessExit>((resolve) => { this.observedExitResolve = resolve; });
	public exited = false;

	constructor(options: RunnerProcessOptions) {
		this.options = options;
		const runnerPath = options.runnerPath ?? process.env.PI_DURABLE_RUNNER_PATH ?? resolveRunnerPath();

		const spawnProcess = options.spawnProcess ?? spawn;
		this.child = spawnProcess(process.execPath, [runnerPath, ...options.args], {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
			env: { ...process.env, ...options.env },
		});

		this.setupStreams();
		this.setupLifecycle();
	}

	public get pendingRequests() {
		return this.channel.pendingRequests;
	}

	private setupStreams() {
		this.child.stdout?.on("data", (chunk: Buffer) => {
			this.channel.feedStdout(chunk, (event) => this.handleIncoming(event));
		});

		const channelIn = (this.child.stdio as unknown as Array<NodeJS.ReadableStream | null>)[3];
		if (channelIn) {
			channelIn.on("data", (chunk: Buffer) => {
				this.channel.feedChannel(chunk, (msg) => this.options.onChannelMessage?.(msg));
			});
		}
	}

	private setupLifecycle() {
		this.child.on("spawn", () => { this.spawnObserved = true; });
		this.child.on("error", (err) => {
			if (!this.spawnObserved) this.spawnFailed = true;
			this.channel.failAll(err);
			this.options.onError?.(err);
		});

		this.child.on("exit", (code, signal) => {
			this.observeExit({ kind: "exit", code, signal });
			this.options.onExit?.(code, signal);
		});

		this.child.on("close", (code, signal) => {
			this.observeExit(this.spawnFailed
				? { kind: "spawn-failure", code: null, signal: null, error: new Error("Runner process failed to spawn") }
				: { kind: "exit", code, signal });
		});

		this.child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			if (!text.includes("DeprecationWarning")) {
				console.error(`[RunnerProcess:stderr] ${text}`);
			}
		});
	}

	public handleIncoming(msg: RunnerEvent): void {
		const handled = this.channel.handleIncoming(msg);
		if (!handled) {
			try {
				this.options.onEvent?.(msg);
			} catch (err) {
				console.error("[RunnerProcess] onEvent subscriber threw an error:", err);
			}
		}
	}

	private observeExit(exit: RunnerProcessExit): void {
		if (this.observedTermination) return;
		this.observedTermination = true;
		this.exited = true;
		this.observedExitResolve(exit);
		this.channel.failAll(exit.kind === "spawn-failure" ? exit.error : new Error(`Runner process exited (code ${exit.code}, signal ${exit.signal})`));
	}

	public async request(cmd: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
		if (this.observedTermination || !this.child.stdin) {
			throw new Error("Runner process is not running");
		}
		return this.channel.createRequest(cmd, timeoutMs, (payload) => {
			this.child.stdin?.write(JSON.stringify(payload) + "\n");
		});
	}

	public async requestOk(cmd: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
		const res: any = await this.request(cmd, timeoutMs);
		if (res && typeof res === "object") {
			if (res.success === false) {
				throw new Error(res.error || `Runner rejected ${String(cmd.type)}`);
			}
			return res.data !== undefined ? res.data : (res.result ?? res);
		}
		return res;
	}

	public sendChannel(msg: unknown): void {
		const channelOut = (this.child.stdio as unknown as Array<NodeJS.WritableStream | null>)[4];
		if (channelOut) {
			channelOut.write(JSON.stringify(msg) + "\n");
		}
	}

	public async closeGracefully(timeoutMs = 5000): Promise<void> {
		if (this.observedTermination) return;

		if (!this.spawnFailed) {
			try {
				await this.request({ type: "abort" }, Math.max(1000, Math.floor(timeoutMs / 2)));
			} catch {}
		}

		this.closeInput();
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			this.observedExit.then(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					this.kill();
					resolve();
				}, timeoutMs);
			}),
		]);
		if (timer) clearTimeout(timer);
		await this.observedExit;
	}

	public closeInput(): void {
		this.child.stdin?.end();
	}

	public kill(): void {
		if (!this.observedTermination) this.child.kill("SIGKILL");
	}
}
