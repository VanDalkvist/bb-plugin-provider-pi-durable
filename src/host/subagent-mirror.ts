import type { RunnerEvent } from "./types.ts";

export interface SubagentMirrorRecord {
	status: "running" | "completed";
	task: string;
	parentToolCallId?: string;
	result?: string;
	actualModel?: { provider: string; modelId: string };
	thinkingLevel?: string;
	source?: "inherit" | "configured";
	policyRevision?: number;
	initialTurnConsumed?: boolean;
	isTruncated?: boolean;
}

const MAX_BUFFERED_EVENTS = 100;
const MAX_OUTPUT_CHARS = 65536;

export class SubagentMirrorManager {
	private mirrors = new Map<string, SubagentMirrorRecord>();
	private pendingByTask = new Map<string, string>();
	private eventBuffers = new Map<string, RunnerEvent[]>();
	private outputTexts = new Map<string, string>();

	public markActive(
		conversationId: string | number,
		meta: {
			task: string;
			parentToolCallId?: string;
			actualModel?: { provider: string; modelId: string };
			thinkingLevel?: string;
			source?: "inherit" | "configured";
			policyRevision?: number;
		},
	): void {
		const key = String(conversationId);
		const existing = this.mirrors.get(key);
		const record: SubagentMirrorRecord = {
			status: "running",
			task: meta.task,
			...(meta.parentToolCallId !== undefined || existing?.parentToolCallId !== undefined ? { parentToolCallId: meta.parentToolCallId ?? existing?.parentToolCallId } : {}),
			...(meta.actualModel !== undefined || existing?.actualModel !== undefined ? { actualModel: meta.actualModel ?? existing?.actualModel } : {}),
			...(meta.thinkingLevel !== undefined || existing?.thinkingLevel !== undefined ? { thinkingLevel: meta.thinkingLevel ?? existing?.thinkingLevel } : {}),
			...(meta.source !== undefined || existing?.source !== undefined ? { source: meta.source ?? existing?.source } : {}),
			...(meta.policyRevision !== undefined || existing?.policyRevision !== undefined ? { policyRevision: meta.policyRevision ?? existing?.policyRevision } : {}),
			...(existing?.initialTurnConsumed ? { initialTurnConsumed: true } : {}),
		};
		this.mirrors.set(key, record);
		if (meta.task.trim()) {
			this.pendingByTask.set(meta.task.trim(), key);
		}
	}

	public bufferEvent(conversationId: string | number, event: RunnerEvent): void {
		const key = String(conversationId);
		const list = this.eventBuffers.get(key) ?? [];
		if (event.type === "runtime_graph_snapshot") {
			const existingIdx = list.findIndex((e) => e.type === "runtime_graph_snapshot");
			if (existingIdx !== -1) {
				list[existingIdx] = event;
				this.eventBuffers.set(key, list);
				return;
			}
		}
		if (list.length >= MAX_BUFFERED_EVENTS) {
			list.shift();
			const rec = this.mirrors.get(key);
			if (rec) rec.isTruncated = true;
		}
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
	): boolean {
		let terminalEmitted = false;
		const buffered = this.drainBufferedEvents(conversationId);
		for (const event of buffered) {
			const childEvent = { ...event, parentRef: undefined };
			const deltas = translator.translate(childEvent, options);
			if (deltas.some((delta) => delta.kind === "turn.boundary")) terminalEmitted = true;
			if (deltas.length > 0) emit(options.threadId, deltas);
		}
		return terminalEmitted;
	}

	public appendOutputText(conversationId: string | number, delta: string): void {
		const key = String(conversationId);
		const current = this.outputTexts.get(key) ?? "";
		const combined = current + delta;
		if (combined.length > MAX_OUTPUT_CHARS) {
			this.outputTexts.set(key, combined.slice(0, MAX_OUTPUT_CHARS));
			const rec = this.mirrors.get(key);
			if (rec) rec.isTruncated = true;
		} else {
			this.outputTexts.set(key, combined);
		}
	}

	public getOutputText(conversationId: string | number): string {
		const key = String(conversationId);
		return this.outputTexts.get(key) ?? this.mirrors.get(key)?.result ?? "";
	}

	public markInitialTurnConsumed(conversationId: string | number): void {
		const key = String(conversationId);
		const existing = this.mirrors.get(key);
		if (existing) {
			existing.initialTurnConsumed = true;
		}
	}

	public markCompleted(conversationId: string | number, result?: string): void {
		const key = String(conversationId);
		const existing = this.mirrors.get(key);
		if (existing) {
			existing.status = "completed";
			if (result !== undefined) existing.result = result;
		} else {
			this.mirrors.set(key, {
				status: "completed",
				task: "",
				...(result !== undefined ? { result } : {}),
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

	public getConversationIds(): string[] {
		return Array.from(this.mirrors.keys());
	}

	public findConversationForTask(task: string): string | undefined {
		return this.pendingByTask.get(task.trim());
	}
}
