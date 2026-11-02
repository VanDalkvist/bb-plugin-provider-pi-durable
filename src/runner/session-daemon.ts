import net from "node:net";
import fs from "node:fs";
import path from "node:path";

export interface SessionDaemonOptions {
	readonly socketFileName?: string;
	readonly connectTimeoutMs?: number;
}

export class SessionDaemon {
	private readonly socketPath: string;
	private server: net.Server | null = null;
	private activeSockets = new Set<net.Socket>();

	constructor(sessionDir: string, options: SessionDaemonOptions = {}) {
		const fileName = options.socketFileName ?? "runner.sock";
		this.socketPath = path.join(sessionDir, fileName);
	}

	getSocketPath(): string {
		return this.socketPath;
	}

	async tryConnectClient(timeoutMs = 250): Promise<net.Socket | null> {
		if (!fs.existsSync(this.socketPath)) {
			return null;
		}

		return new Promise<net.Socket | null>((resolve) => {
			let settled = false;
			const socket = net.createConnection({ path: this.socketPath });

			const cleanup = (result: net.Socket | null) => {
				if (settled) return;
				settled = true;
				socket.removeAllListeners();
				if (!result) {
					socket.destroy();
					// If connection failed or timed out, the socket file is stale/dead
					try {
						if (fs.existsSync(this.socketPath)) {
							fs.unlinkSync(this.socketPath);
						}
					} catch {
						// Ignore unlink race
					}
				}
				resolve(result);
			};

			const timer = setTimeout(() => cleanup(null), timeoutMs);

			socket.once("connect", () => {
				clearTimeout(timer);
				if (!settled) {
					settled = true;
					resolve(socket);
				}
			});

			socket.once("error", () => {
				clearTimeout(timer);
				cleanup(null);
			});
		});
	}

	async startMaster(onConnection: (socket: net.Socket) => void): Promise<boolean> {
		if (this.server) {
			return true;
		}

		// Ensure any dead socket is removed before listening
		if (fs.existsSync(this.socketPath)) {
			try {
				fs.unlinkSync(this.socketPath);
			} catch {
				// Ignore
			}
		}

		return new Promise<boolean>((resolve, reject) => {
			const server = net.createServer((socket) => {
				this.activeSockets.add(socket);
				socket.on("close", () => this.activeSockets.delete(socket));
				onConnection(socket);
			});

			server.once("error", (err) => {
				this.server = null;
				reject(err);
			});

			server.listen(this.socketPath, () => {
				this.server = server;
				resolve(true);
			});
		});
	}

	async close(): Promise<void> {
		for (const socket of this.activeSockets) {
			try {
				socket.destroy();
			} catch {
				// Ignore
			}
		}
		this.activeSockets.clear();

		if (this.server) {
			await new Promise<void>((resolve) => {
				this.server!.close(() => resolve());
			});
			this.server = null;
		}

		if (fs.existsSync(this.socketPath)) {
			try {
				fs.unlinkSync(this.socketPath);
			} catch {
				// Ignore
			}
		}
	}
}
