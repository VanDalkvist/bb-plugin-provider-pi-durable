import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { resolveRunnerPath } from "./paths.ts";
import type { RunnerEvent } from "./types.ts";

export interface RunnerProcessOptions {
	cwd: string;
	args: string[];
	env?: Record<string, string>;
	onEvent?: (event: RunnerEvent) => void;
	onChannelMessage?: (msg: unknown) => void;
}

export class RunnerProcess {
	private options: RunnerProcessOptions;
	private child: ChildProcess;
	private channelDecoder = new StringDecoder("utf8");
	private channelBuf = "";
	private pendingRequests = new Map<string, { resolve: (val: unknown) => void; reject: (err: Error) => void; timer?: NodeJS.Timeout }>();
	private nextRequestId = 0;
	public exited = false;

	constructor(options: RunnerProcessOptions) {
		this.options = options;
		const runnerPath = process.env.PI_DURABLE_RUNNER_PATH || resolveRunnerPath();

		this.child = spawn(process.execPath, [runnerPath, ...options.args], {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
			env: {
				...process.env,
				...options.env,
			},
		});

		this.setupStdout();
		this.setupChannel();
		this.setupLifecycle();
	}

	private setupStdout() {
		let stdoutBuf = "";
		const decoder = new StringDecoder("utf8");

		this.child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBuf += decoder.write(chunk);
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed) as RunnerEvent;
					this.handleIncoming(parsed);
				} catch (err) {
					console.error(`[RunnerProcess] Failed to parse or handle stdout line: ${trimmed}`, err);
				}
			}
		});
	}

	private setupChannel() {
		// FD 3 is child-to-host channel
		const stdioList = this.child.stdio as unknown as Array<NodeJS.ReadableStream | null>;
		const channelIn = stdioList[3];
		if (channelIn) {
			channelIn.on("data", (chunk: Buffer) => {
				this.channelBuf += this.channelDecoder.write(chunk);
				const lines = this.channelBuf.split("\n");
				this.channelBuf = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const parsed = JSON.parse(trimmed);
						this.options.onChannelMessage?.(parsed);
					} catch (err) {
						console.error(`[RunnerProcess] Failed to parse channel message: ${trimmed}`, err);
					}
				}
			});
		}
	}

	private setupLifecycle() {
		this.child.on("exit", (code, signal) => {
			this.exited = true;
			for (const { reject, timer } of this.pendingRequests.values()) {
				if (timer) clearTimeout(timer);
				reject(new Error(`Runner process exited (code ${code}, signal ${signal})`));
			}
			this.pendingRequests.clear();
		});

		this.child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			if (!text.includes("DeprecationWarning")) {
				console.error(`[RunnerProcess:stderr] ${text}`);
			}
		});
	}

	private handleIncoming(msg: RunnerEvent) {
		if (typeof msg.id !== "undefined") {
			const reqId = String(msg.id);
			const pending = this.pendingRequests.get(reqId);
			if (pending) {
				if (pending.timer) clearTimeout(pending.timer);
				this.pendingRequests.delete(reqId);
				if (msg.error) {
					const errObj = msg.error as { message?: string };
					pending.reject(new Error(errObj?.message || String(msg.error)));
				} else {
					pending.resolve(msg.result ?? msg);
				}
				return;
			}
		}

		// Dispatch normal event to subscriber
		try {
			this.options.onEvent?.(msg);
		} catch (err) {
			console.error(`[RunnerProcess] onEvent subscriber threw an error:`, err);
		}
	}

	public async request(cmd: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
		if (this.exited || !this.child.stdin) {
			throw new Error("Runner process is not running");
		}

		this.nextRequestId++;
		const id = `req_${this.nextRequestId}`;
		const payload = { ...cmd, id };

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Runner request timed out (${timeoutMs}ms): ${cmd.type || JSON.stringify(cmd)}`));
			}, timeoutMs);

			this.pendingRequests.set(id, { resolve, reject, timer });
			this.child.stdin?.write(JSON.stringify(payload) + "\n");
		});
	}

	public async requestOk(cmd: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
		return this.request(cmd, timeoutMs);
	}

	public sendChannel(msg: unknown): void {
		const stdioList = this.child.stdio as unknown as Array<NodeJS.WritableStream | null>;
		const channelOut = stdioList[4];
		if (channelOut) {
			channelOut.write(JSON.stringify(msg) + "\n");
		}
	}

	public async closeGracefully(timeoutMs = 5000): Promise<void> {
		if (this.exited) return;

		// Intentionally best-effort abort before termination per AP-022
		try {
			await this.request({ type: "abort" }, Math.max(1000, Math.floor(timeoutMs / 2)));
		} catch {
			// intentionally ignored: process may already be terminating or unresponsive
		}

		this.child.stdin?.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.kill();
				resolve();
			}, timeoutMs);

			this.child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	public kill(): void {
		if (!this.exited) {
			this.child.kill("SIGKILL");
			this.exited = true;
		}
	}
}
