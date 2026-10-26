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
				label: "Завершает дочернюю работу",
				isFinal: false,
				isCompleting: true,
				abortRequested: Boolean(abortRequested),
				blockedReason: blocked,
			};
		case "running":
			return {
				rawStatus: "running",
				label: label ?? "Выполняется",
				isFinal: false,
				abortRequested: Boolean(abortRequested),
				blockedReason: blocked,
			};
		case "waiting":
			return {
				rawStatus: "waiting",
				label: label ?? "Ожидает завершения зависимостей",
				isFinal: false,
				waitingOn: state.on,
				abortRequested: Boolean(abortRequested),
				blockedReason: blocked,
			};
		case "sleeping":
			return {
				rawStatus: "sleeping",
				label: label ?? "Ожидает таймер",
				isFinal: false,
				sleepUntil: state.until,
				abortRequested: Boolean(abortRequested),
				blockedReason: blocked,
			};
		case "pending":
			return {
				rawStatus: "pending",
				label: label ?? "В очереди",
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
			label = hasToolError ? "Завершено с ошибкой инструмента" : "Успешно завершено";
			break;
		case "failed":
			label = "Ошибка задачи";
			break;
		case "aborted":
			label = "Прервано";
			break;
		case "faulted":
			label = "Аварийный сбой рантайма";
			break;
		case "orphaned":
			label = "Осиротевшая задача";
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
