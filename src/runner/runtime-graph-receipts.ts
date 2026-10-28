import type { TaskRecord } from "@earendil-works/pi-durable";
import type { RuntimeTaskReceipt, TaskOutcomeName, TaskTokensUsage } from "../runtime-graph/types.ts";
import { MAX_RECEIPTS, MAX_PREVIEW_LENGTH } from "../runtime-graph/schema.ts";

export const MAX_ERROR_MESSAGE_LENGTH = 1024;
export const MAX_ERROR_CODE_LENGTH = 64;

export interface TerminalOptions {
	readonly isToolError?: boolean;
	readonly durationMs?: number;
	readonly preview?: string;
	readonly toolName?: string;
	readonly targetHint?: string;
	readonly startedAt?: number;
	readonly tokens?: TaskTokensUsage;
}

/**
 * Ring-buffer collector for recent authoritative task receipts.
 * Maintains up to capacity (default 128) receipts, oldest evicted first.
 */
export class RuntimeGraphReceiptsCollector {
	private readonly capacity: number;
	private readonly receipts: RuntimeTaskReceipt[] = [];
	private readonly knownTaskIds = new Set<number>();

	constructor(capacity: number = MAX_RECEIPTS) {
		this.capacity = capacity;
	}

	recordTerminal(
		task: TaskRecord<unknown, unknown, unknown>,
		options?: TerminalOptions,
	): RuntimeTaskReceipt | undefined {
		const state = task.state;
		if (state.status !== "terminal") {
			return undefined;
		}

		const taskId = Number(task.id);
		let outcome: TaskOutcomeName = "completed";
		let error: { message: string; code?: string } | undefined;

		const taskOutcome =
			typeof state.outcome === "object" && state.outcome !== null && "status" in state.outcome
				? (state.outcome as { status: string; error?: unknown; reason?: unknown })
				: { status: String(state.outcome ?? "completed") };
		outcome = (taskOutcome.status as TaskOutcomeName) ?? "completed";
		if ("error" in taskOutcome && taskOutcome.error !== undefined && taskOutcome.error !== null) {
			let rawMsg = "Task execution failed";
			let rawCode: string | undefined;
			if (typeof taskOutcome.error === "object") {
				const err = taskOutcome.error as { message?: unknown; code?: unknown };
				if (err.message !== undefined && err.message !== null) rawMsg = String(err.message);
				if (err.code !== undefined && err.code !== null) rawCode = String(err.code);
			} else {
				rawMsg = String(taskOutcome.error);
			}
			error = {
				message: rawMsg.length > MAX_ERROR_MESSAGE_LENGTH ? rawMsg.slice(0, MAX_ERROR_MESSAGE_LENGTH) : rawMsg,
				code: rawCode ? (rawCode.length > MAX_ERROR_CODE_LENGTH ? rawCode.slice(0, MAX_ERROR_CODE_LENGTH) : rawCode) : undefined,
			};
		} else if ("reason" in taskOutcome && taskOutcome.reason !== undefined && taskOutcome.reason !== null) {
			const rawReason = String(taskOutcome.reason);
			error = {
				message: rawReason.length > MAX_ERROR_MESSAGE_LENGTH ? rawReason.slice(0, MAX_ERROR_MESSAGE_LENGTH) : rawReason,
			};
		}

		let preview = options?.preview;
		let toolName = options?.toolName;
		let targetHint = options?.targetHint;
		if (preview && preview.length > MAX_PREVIEW_LENGTH) {
			preview = preview.slice(0, MAX_PREVIEW_LENGTH);
		}
		if (toolName && toolName.length > 64) {
			toolName = toolName.slice(0, 64);
		}
		if (targetHint && targetHint.length > 128) {
			targetHint = targetHint.slice(0, 128);
		}
		if (!preview && toolName) {
			preview = targetHint ? `${toolName}: ${targetHint}` : toolName;
		}

		const startedAt =
			options?.startedAt ??
			(task.startedAt !== undefined && task.startedAt !== null ? Number(task.startedAt) : undefined);

		const durationMs =
			options?.durationMs ??
			(task.endedAt && startedAt && task.endedAt >= startedAt
				? task.endedAt - startedAt
				: undefined);

		const owner =
			task.owner !== undefined && task.owner !== null && Number(task.owner) > 0
				? Number(task.owner)
				: undefined;

		const receipt: RuntimeTaskReceipt = {
			taskId,
			conversationId: Number(task.conversationId),
			owner,
			kind: task.kind,
			outcome,
			isToolError: options?.isToolError,
			error,
			endedAt: task.endedAt ?? Date.now(),
			startedAt,
			durationMs,
			preview,
			toolName,
			targetHint,
			tokens: options?.tokens,
		};

		this.pushReceipt(receipt);
		return receipt;
	}

	hydrateFromScan(tasks: readonly TaskRecord<unknown, unknown, unknown>[]): void {
		for (const task of tasks) {
			if (task.state.status === "terminal") {
				this.recordTerminal(task);
			}
		}
	}

	getReceipts(): readonly RuntimeTaskReceipt[] {
		return [...this.receipts];
	}

	hasReceipt(taskId: number): boolean {
		return this.knownTaskIds.has(taskId);
	}

	private pushReceipt(receipt: RuntimeTaskReceipt): void {
		// If already present, update existing in-place or return
		const existingIndex = this.receipts.findIndex((r) => r.taskId === receipt.taskId);
		if (existingIndex !== -1) {
			this.receipts[existingIndex] = receipt;
			return;
		}

		if (this.receipts.length >= this.capacity) {
			const evicted = this.receipts.shift();
			if (evicted) {
				this.knownTaskIds.delete(evicted.taskId);
			}
		}

		this.receipts.push(receipt);
		this.knownTaskIds.add(receipt.taskId);
	}
}
