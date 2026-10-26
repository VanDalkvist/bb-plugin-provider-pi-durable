import type { TaskRecord } from "@earendil-works/pi-durable";
import type { RuntimeTaskReceipt, TaskOutcomeName } from "../runtime-graph/types.ts";
import { MAX_RECEIPTS, MAX_PREVIEW_LENGTH } from "../runtime-graph/schema.ts";

export interface TerminalOptions {
	readonly isToolError?: boolean;
	readonly durationMs?: number;
	readonly preview?: string;
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
	): RuntimeTaskReceipt {
		const taskId = Number(task.id);
		let outcome: TaskOutcomeName = "completed";
		let error: { message: string; code?: string } | undefined;

		const state = task.state;
		if (state.status === "terminal" || state.status === "completing") {
			const taskOutcome =
				typeof state.outcome === "object" && state.outcome !== null && "status" in state.outcome
					? (state.outcome as { status: string; error?: unknown; reason?: unknown })
					: { status: String(state.outcome ?? "completed") };
			outcome = (taskOutcome.status as TaskOutcomeName) ?? "completed";
			if ("error" in taskOutcome && taskOutcome.error) {
				const err = taskOutcome.error as { message?: string; code?: string };
				error = {
					message: String(err.message ?? "Task execution failed"),
					code: err.code ? String(err.code) : undefined,
				};
			} else if ("reason" in taskOutcome && taskOutcome.reason) {
				error = { message: String(taskOutcome.reason) };
			}
		}

		let preview = options?.preview;
		if (preview && preview.length > MAX_PREVIEW_LENGTH) {
			preview = preview.slice(0, MAX_PREVIEW_LENGTH);
		}

		const durationMs =
			options?.durationMs ??
			(task.endedAt && task.startedAt && task.endedAt >= task.startedAt
				? task.endedAt - task.startedAt
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
			durationMs,
			preview,
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
