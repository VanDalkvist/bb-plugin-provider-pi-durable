import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadDelta } from "./types.ts";

export interface ActiveToolItemRecord {
	providerItemId: string;
	threadId: string;
	toolName: string;
	startedAt: number;
	shape?: Record<string, unknown>;
	parentRef?: string;
}

export class ToolItemReconciler {
	private sessionDir?: string;
	private items = new Map<string, ActiveToolItemRecord>();

	constructor(sessionDir?: string) {
		this.sessionDir = sessionDir;
		this.loadFromDisk();
	}

	public setSessionDir(dir: string): void {
		this.sessionDir = dir;
		this.loadFromDisk();
	}

	private getManifestPath(): string | undefined {
		return this.sessionDir ? join(this.sessionDir, "adapter-active-items.json") : undefined;
	}

	private loadFromDisk(): void {
		const path = this.getManifestPath();
		if (!path || !existsSync(path)) return;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					if (item && typeof item.providerItemId === "string" && typeof item.threadId === "string") {
						this.items.set(item.providerItemId, item);
					}
				}
			}
		} catch (err) {
			console.warn(`[ToolItemReconciler] Failed to load active items: ${err}`);
		}
	}

	private saveToDisk(): void {
		const path = this.getManifestPath();
		if (!path || !this.sessionDir) return;
		try {
			mkdirSync(this.sessionDir, { recursive: true });
			const list = Array.from(this.items.values()).slice(0, 100);
			writeFileSync(path, JSON.stringify(list, null, 2), "utf8");
		} catch (err) {
			console.warn(`[ToolItemReconciler] Failed to save active items: ${err}`);
		}
	}

	public recordOpen(threadId: string, providerItemId: string, toolName: string, shape?: Record<string, unknown>, parentRef?: string): void {
		this.items.set(providerItemId, {
			providerItemId,
			threadId,
			toolName,
			startedAt: Date.now(),
			shape,
			parentRef,
		});
		this.saveToDisk();
	}

	public recordClose(threadId: string, providerItemId: string): void {
		if (this.items.delete(providerItemId)) {
			this.saveToDisk();
		}
	}

	public getOpenItems(threadId: string): ActiveToolItemRecord[] {
		return Array.from(this.items.values()).filter((i) => i.threadId === threadId);
	}

	public reconcileInterruptedItems(
		threadId: string,
		emit: (delta: ThreadDelta) => void,
		reason = "Tool execution was interrupted and may have partially run",
	): string[] {
		const targets = this.getOpenItems(threadId);
		const closedIds: string[] = [];

		for (const target of targets) {
			this.items.delete(target.providerItemId);
			closedIds.push(target.providerItemId);

			const closeDelta: ThreadDelta = {
				kind: "item.close",
				key: {
					providerItemId: target.providerItemId,
					...(target.parentRef ? { parentRef: target.parentRef } : {}),
				},
				status: "failed",
				exitCode: 1,
				resultText: reason,
				error: { message: reason },
				item: {
					...(target.shape ?? { type: target.toolName === "bash" ? "command" : "tool", tool: target.toolName }),
					error: reason,
					...(target.parentRef ? { parentToolCallId: target.parentRef } : {}),
				},
			};
			emit(closeDelta);
		}

		if (closedIds.length > 0) {
			this.saveToDisk();
		}

		return closedIds;
	}
}
