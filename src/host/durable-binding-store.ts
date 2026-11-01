import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
		this.persistAdapterManifest(threadId, convStr, parentThreadId);
		if (this.runnerRpc) {
			void this.runnerRpc({
				type: "register_binding",
				bbThreadId: threadId,
				conversationId: Number(conversationId),
				...(parentThreadId ? { parentThreadId } : {}),
			}).catch((err) => console.warn(`[BindingManager] Failed to persist binding to runner: ${err}`));
		}
	}

	private persistAdapterManifest(threadId: string, conversationId: string, parentThreadId?: string): void {
		if (!this.sessionDir) return;
		try {
			mkdirSync(this.sessionDir, { recursive: true });
			const manifestPath = join(this.sessionDir, "adapter-bindings.json");
			const existing = this.readOfflineBindings(this.sessionDir);
			const filtered = existing.filter((b) => b.threadId !== threadId && b.bbThreadId !== threadId);
			filtered.push({ threadId, bbThreadId: threadId, conversationId, parentThreadId });
			writeFileSync(manifestPath, JSON.stringify(filtered, null, 2), "utf8");
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
				bindings?: Array<{ bbThreadId?: string; conversationId?: string | number }>;
				data?: { bindings?: Array<{ bbThreadId?: string; conversationId?: string | number }> };
			} | undefined;
			const rawList = res?.bindings ?? res?.data?.bindings;
			if (Array.isArray(rawList)) {
				for (const item of rawList) {
					if (item && typeof item === "object" && typeof item.bbThreadId === "string" && item.conversationId !== undefined) {
						const convStr = String(item.conversationId);
						this.convToThread.set(convStr, item.bbThreadId);
						this.threadToConv.set(item.bbThreadId, convStr);
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
			} catch (err) { console.warn(`[BindingManager] Failed to read adapter manifest: ${err}`); }
		}

		const dbPath = sessionFilePath.endsWith(".sqlite") ? sessionFilePath : join(sessionFilePath, "session.sqlite");
		if (!existsSync(dbPath)) return [];

		const results: StoredBindingItem[] = [];
		let db: DatabaseSync | undefined;
		try {
			db = new DatabaseSync(dbPath, { readOnly: true });
			const hasDocs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", "documents");
			const hasRevs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name IN (?, ?)").get("table", "document_revisions", "documentRevisions");
			if (!hasDocs || !hasRevs) return [];

			const revsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", "document_revisions") ? "document_revisions" : "documentRevisions";
			const stmt = db.prepare(`SELECT r.content FROM documents d JOIN ${revsTable} r ON d.id = r.document_id WHERE d.kind IN ('durable.binding', '"durable.binding"') AND d.retired_at IS NULL ORDER BY r.seq DESC`);
			const seen = new Set<string>();

			for (const row of stmt.all() as Array<{ content: string }>) {
				try {
					const b = (JSON.parse(row.content) as { binding?: { threadId?: string; conversationId?: string | number } })?.binding;
					if (b && typeof b.threadId === "string" && b.conversationId !== undefined && !seen.has(b.threadId)) {
						seen.add(b.threadId);
						results.push({ threadId: b.threadId, bbThreadId: b.threadId, conversationId: String(b.conversationId) });
					}
				} catch { /* Ignore malformed revision content */ }
			}
		} catch (err) {
			console.warn(`[BindingManager] Failed to read offline bindings: ${err}`);
		} finally {
			try { db?.close(); } catch { /* Ignore close error */ }
		}
		return results;
	}

	public hydrateFromOffline(sessionFilePath: string): void {
		for (const item of this.readOfflineBindings(sessionFilePath)) {
			this.convToThread.set(item.conversationId, item.threadId);
			this.threadToConv.set(item.threadId, item.conversationId);
		}
	}
}
