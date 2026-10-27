import type {
	RuntimeTaskNode,
	RuntimeTaskReceipt,
	RuntimeTaskState,
	ProjectedTaskState,
	ProjectedReceiptState,
	LiveTaskStatus,
	BlockedTaskReason,
} from "./types.ts";

export function projectTaskState(input: {
	state: RuntimeTaskState;
	abortRequested?: boolean;
	blocked?: BlockedTaskReason;
	label?: string;
}): ProjectedTaskState {
	const { state, abortRequested, blocked, label } = input;

	switch (state.status) {
		case "completing":
			return {
				rawStatus: "completing",
				label: "Completing child work",
				isFinal: false,
				isCompleting: true,
				abortRequested: Boolean(abortRequested),
				blockedReason: blocked,
			};
		case "running":
			return {
				rawStatus: "running",
				label: label ?? "Running",
				isFinal: false,
				abortRequested: Boolean(abortRequested),
				blockedReason: blocked,
			};
		case "waiting":
			return {
				rawStatus: "waiting",
				label: label ?? "Waiting on dependencies",
				isFinal: false,
				waitingOn: state.on,
				abortRequested: Boolean(abortRequested),
				blockedReason: blocked,
			};
		case "sleeping":
			return {
				rawStatus: "sleeping",
				label: label ?? "Waiting for timer",
				isFinal: false,
				sleepUntil: state.until,
				abortRequested: Boolean(abortRequested),
				blockedReason: blocked,
			};
		case "pending":
			return {
				rawStatus: "pending",
				label: label ?? "Queued",
				isFinal: false,
				abortRequested: Boolean(abortRequested),
				blockedReason: blocked,
			};
		default: {
			const _exhaustive: never = state;
			throw new Error(`Unhandled live task status: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

export function projectTaskReceipt(receipt: RuntimeTaskReceipt): ProjectedReceiptState {
	const hasToolError = Boolean(receipt.isToolError);

	let label: string;
	switch (receipt.outcome) {
		case "completed":
			label = hasToolError ? "Completed with tool error" : "Completed successfully";
			break;
		case "failed":
			label = "Task failed";
			break;
		case "aborted":
			label = "Aborted";
			break;
		case "faulted":
			label = "Runtime fault";
			break;
		case "orphaned":
			label = "Orphaned task";
			break;
		default: {
			const _exhaustive: never = receipt.outcome;
			throw new Error(`Unhandled task outcome: ${_exhaustive}`);
		}
	}

	return {
		outcome: receipt.outcome,
		isFinal: true,
		hasToolError,
		label,
		preview: receipt.preview,
		endedAt: receipt.endedAt,
		durationMs: receipt.durationMs,
	};
}
