import { spawn, type ChildProcess } from "node:child_process";
import { openSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { resolveRunnerPath } from "./paths.ts";

export interface RunnerProcessOptions {
	cwd?: string;
	args: string[];
	env?: Record<string, string>;
	onEvent?: (event: any) => void;
	onChannelMessage?: (msg: any) => void;
	onExit?: (info: { code: number | null; signal: string | null }) => void;
}

export class RunnerProcess {
	public child: ChildProcess;
	public exited = false;
	private pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void; timer?: NodeJS.Timeout }>();
	private nextId = 0;
	private stdoutDecoder = new StringDecoder("utf8");
	private stdoutBuf = "";
	private channelDecoder = new StringDecoder("utf8");
	private channelBuf = "";

	constructor(private options: RunnerProcessOptions) {
		const runnerScript = resolveRunnerPath();
		const pluginRoot = dirname(dirname(runnerScript));
		const nodePaths = [
			join(pluginRoot, "node_modules"),
			process.env.NODE_PATH,
			"/opt/homebrew/lib/node_modules",
		].filter(Boolean).join(":");

		const childEnv = {
			...process.env,
			...options.env,
			ELECTRON_RUN_AS_NODE: "1",
			NODE_PATH: nodePaths,
		};

		// Spawn child with stdio [pipe, pipe, inherit, pipe (FD 3), pipe (FD 4)]
		this.child = spawn(process.execPath, [runnerScript, ...options.args], {
			cwd: options.cwd || process.cwd(),
			env: childEnv,
			stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"],
		});

		this.setupStdio();
		this.setupChannel();
		this.setupLifecycle();
	}

	private setupStdio() {
		this.child.stdout?.on("data", (chunk: Buffer) => {
			this.stdoutBuf += this.stdoutDecoder.write(chunk);
			const lines = this.stdoutBuf.split("\n");
			this.stdoutBuf = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed);
					this.handleIncoming(parsed);
				} catch {}
			}
		});
	}

	private setupChannel() {
		// FD 3 is child-to-host channel
		const channelIn = (this.child.stdio as any[])[3];
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
					} catch {}
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
			this.options.onExit?.({ code, signal });
		});
	}

	private handleIncoming(msg: any) {
		if (msg.type === "response" && msg.id !== undefined) {
			const pending = this.pendingRequests.get(String(msg.id));
			if (pending) {
				this.pendingRequests.delete(String(msg.id));
				if (pending.timer) clearTimeout(pending.timer);
				if (msg.success) {
					pending.resolve(msg.data);
				} else {
					pending.reject(new Error(msg.error || "Runner command failed"));
				}
				return;
			}
		}
		this.options.onEvent?.(msg);
	}

	public async request(cmd: Record<string, any>, timeoutMs = 60000): Promise<any> {
		if (this.exited) throw new Error("Runner process has exited");
		this.nextId += 1;
		const id = String(this.nextId);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Runner request timed out after ${timeoutMs}ms (${cmd.type})`));
			}, timeoutMs);
			timer.unref?.();

			this.pendingRequests.set(id, { resolve, reject, timer });
			const payload = JSON.stringify({ ...cmd, id }) + "\n";
			this.child.stdin?.write(payload);
		});
	}

	public async requestOk(cmd: Record<string, any>, timeoutMs = 60000): Promise<any> {
		return this.request(cmd, timeoutMs);
	}

	public sendChannel(msg: any) {
		if (this.exited) return;
		const channelOut = (this.child.stdio as any[])[4];
		if (channelOut) {
			channelOut.write(JSON.stringify(msg) + "\n");
		}
	}

	public kill() {
		this.exited = true;
		this.child.kill("SIGTERM");
	}

	public async closeGracefully(timeoutMs = 5000): Promise<void> {
		if (this.exited) return;
		try {
			await this.request({ type: "abort" }, Math.max(1000, Math.floor(timeoutMs / 2))).catch(() => {});
		} finally {
			this.kill();
		}
	}
}
