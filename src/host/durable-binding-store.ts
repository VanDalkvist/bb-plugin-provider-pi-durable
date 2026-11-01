import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function atomicWriteJsonSync(filePath: string, data: unknown): void {
	const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
	writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
	renameSync(tempPath, filePath);
}

export interface StoredBindingItem {
	readonly threadId: string;
	readonly bbThreadId: string;
	readonly conversationId: string;
	readonly parentThreadId?: string | null;
}

export class DurableBindingManager {
	private convToThread = new Map<string, string>();
	private threadToConv = new Map<string, string>();
	private runnerRpc?: (cmd: Record<string, unknown>) => Promise<unknown>;
	private sessionDir?: string;

	public setSessionDir(dir: string): void { this.sessionDir = dir; }
	public setRpc(rpc: (cmd: Record<string, unknown>) => Promise<unknown>): void { this.runnerRpc = rpc; }

	public register(threadId: string, conversationId?: string | number, parentThreadId?: string): void {
		if (conversationId === undefined || conversationId === null || String(conversationId).trim() === "") return;
		const convStr = String(conversationId);
		this.convToThread.set(convStr, threadId);
		this.threadToConv.set(threadId, convStr);

		if (this.runnerRpc) {
			void this.runnerRpc({
				type: "register_binding",
				threadId,
				conversationId: convStr,
				parentThreadId,
			}).catch((err) => {
				console.warn(`[BindingManager] Failed to persist binding to runner: ${err}`);
			});
		}

		if (!this.sessionDir) return;
		try {
			mkdirSync(this.sessionDir, { recursive: true });
			const manifestPath = join(this.sessionDir, "adapter-bindings.json");
			const existing = this.readOfflineBindings(this.sessionDir);
			const filtered = existing.filter((b) => b.threadId !== threadId && b.bbThreadId !== threadId);
			filtered.push({ threadId, bbThreadId: threadId, conversationId: convStr, parentThreadId });
			atomicWriteJsonSync(manifestPath, filtered);
		} catch (err) {
			console.warn(`[BindingManager] Failed to write adapter manifest: ${err}`);
		}
	}

	public unregister(threadId: string): void {
		const convStr = this.threadToConv.get(threadId);
		if (convStr !== undefined) {
			this.convToThread.delete(convStr);
			this.threadToConv.delete(threadId);
		}
		if (this.sessionDir && existsSync(this.sessionDir)) {
			try {
				const manifestPath = join(this.sessionDir, "adapter-bindings.json");
				const existing = this.readOfflineBindings(this.sessionDir);
				const filtered = existing.filter((b) => b.threadId !== threadId && b.bbThreadId !== threadId);
				atomicWriteJsonSync(manifestPath, filtered);
			} catch (err) {
				console.warn(`[BindingManager] Failed to update adapter manifest on unregister: ${err}`);
			}
		}
	}

	public getThreadId(conversationId: string | number): string | undefined {
		return this.convToThread.get(String(conversationId));
	}

	public getConversationId(threadId: string): string | undefined {
		return this.threadToConv.get(threadId);
	}

	public async hydrateFromRunner(): Promise<void> {
		if (!this.runnerRpc) return;
		try {
			const res = await this.runnerRpc({ type: "get_all_bindings" }) as {
				bindings?: Array<{ bbThreadId?: string; threadId?: string; conversationId?: string | number }>;
				data?: { bindings?: Array<{ bbThreadId?: string; threadId?: string; conversationId?: string | number }> };
			} | undefined;
			const rawList = res?.bindings ?? res?.data?.bindings;
			if (Array.isArray(rawList)) {
				for (const item of rawList) {
					const tid = item?.threadId ?? item?.bbThreadId;
					if (item && typeof item === "object" && typeof tid === "string" && item.conversationId !== undefined) {
						const convStr = String(item.conversationId);
						this.convToThread.set(convStr, tid);
						this.threadToConv.set(tid, convStr);
					}
				}
			}
		} catch (err) {
			console.warn(`[BindingManager] Failed to hydrate bindings from runner: ${err}`);
		}
	}

	public readOfflineBindings(sessionFilePath: string): StoredBindingItem[] {
		const dir = sessionFilePath.endsWith(".sqlite") ? dirname(sessionFilePath) : sessionFilePath;
		const manifestPath = join(dir, "adapter-bindings.json");
		if (existsSync(manifestPath)) {
			try {
				const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
				if (Array.isArray(parsed)) {
					return parsed.filter((i) => i && (typeof i.threadId === "string" || typeof i.bbThreadId === "string") && i.conversationId !== undefined)
						.map((i) => {
							const tid = i.threadId ?? i.bbThreadId;
							return { threadId: tid, bbThreadId: tid, conversationId: String(i.conversationId), parentThreadId: i.parentThreadId ?? null };
						});
				}
			} catch (err) {
				console.warn(`[BindingManager] Failed to read adapter manifest: ${err}`);
			}
		}
		return [];
	}

	public hydrateFromOffline(sessionFilePath: string): void {
		const items = this.readOfflineBindings(sessionFilePath);
		for (const item of items) {
			this.convToThread.set(item.conversationId, item.threadId);
			this.threadToConv.set(item.threadId, item.conversationId);
		}
	}
}
