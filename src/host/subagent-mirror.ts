import type { RunnerEvent } from "./types.ts";

export interface SubagentMirrorRecord {
	status: "running" | "completed";
	task: string;
	parentToolCallId?: string;
	result?: string;
}

export class SubagentMirrorManager {
	private mirrors = new Map<string, SubagentMirrorRecord>();
	private pendingByTask = new Map<string, string>();
	private eventBuffers = new Map<string, RunnerEvent[]>();
	private outputTexts = new Map<string, string>();

	public markActive(
		conversationId: string | number,
		meta: { task: string; parentToolCallId?: string },
	): void {
		const key = String(conversationId);
		this.mirrors.set(key, {
			status: "running",
			task: meta.task,
			parentToolCallId: meta.parentToolCallId,
		});
		if (meta.task.trim()) {
			this.pendingByTask.set(meta.task.trim(), key);
		}
	}

	public bufferEvent(conversationId: string | number, event: RunnerEvent): void {
		const key = String(conversationId);
		const list = this.eventBuffers.get(key) ?? [];
		list.push(event);
		this.eventBuffers.set(key, list);
	}

	public drainBufferedEvents(conversationId: string | number): RunnerEvent[] {
		const key = String(conversationId);
		const list = this.eventBuffers.get(key) ?? [];
		this.eventBuffers.delete(key);
		return list;
	}

	public flushBufferedDeltas(
		conversationId: string | number,
		translator: import("./delta-translator.ts").DeltaTranslator,
		options: { threadId: string; cwd?: string; providerOptions?: Record<string, unknown> },
		emit: (threadId: string, deltas: import("./types.ts").ThreadDelta[]) => void,
	): void {
		const buffered = this.drainBufferedEvents(conversationId);
		for (const event of buffered) {
			const childEvent = { ...event, parentRef: undefined };
			const deltas = translator.translate(childEvent, options);
			if (deltas.length > 0) emit(options.threadId, deltas);
		}
	}

	public appendOutputText(conversationId: string | number, delta: string): void {
		const key = String(conversationId);
		const current = this.outputTexts.get(key) ?? "";
		this.outputTexts.set(key, current + delta);
	}

	public getOutputText(conversationId: string | number): string {
		const key = String(conversationId);
		return this.outputTexts.get(key) ?? this.mirrors.get(key)?.result ?? "";
	}

	public markCompleted(conversationId: string | number, result?: string): void {
		const key = String(conversationId);
		const existing = this.mirrors.get(key);
		if (existing) {
			existing.status = "completed";
			existing.result = result;
		} else {
			this.mirrors.set(key, {
				status: "completed",
				task: "",
				result,
			});
		}
	}

	public consumeCompleted(conversationId: string | number): void {
		const key = String(conversationId);
		const record = this.mirrors.get(key);
		if (record) {
			if (record.task.trim()) {
				this.pendingByTask.delete(record.task.trim());
			}
			this.mirrors.delete(key);
			this.eventBuffers.delete(key);
			this.outputTexts.delete(key);
		}
	}

	public getState(conversationId: string | number): SubagentMirrorRecord | undefined {
		return this.mirrors.get(String(conversationId));
	}

	public findConversationForTask(task: string): string | undefined {
		return this.pendingByTask.get(task.trim());
	}
}
