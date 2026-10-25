type Operation = "compact_context" | "session_before_compact" | "session_compact";
export class CompactionSideEffectError extends Error {
	readonly code: "CONTEXT_RETRIEVAL_FAILED" | "COMPACTION_HOOK_FAILED";
	readonly operation: Operation;
	constructor(operation: Operation, cause: unknown) {
		const code = operation === "compact_context" ? "CONTEXT_RETRIEVAL_FAILED" : "COMPACTION_HOOK_FAILED";
		super(`${operation} failed (${code})`, { cause });
		this.name = "CompactionSideEffectError";
		this.operation = operation;
		this.code = code;
	}
}

type Attempt<T> = { status: "succeeded"; value: T } | { status: "failed"; error: CompactionSideEffectError };

/** Only extension side effects are best effort; the native compaction operation is never wrapped here. */
export async function runCompactionSideEffect<T>(
	operation: Operation,
	action: () => Promise<T>,
	notice: (level: "warning", message: string) => void,
): Promise<Attempt<T>> {
	try { return { status: "succeeded", value: await action() }; }
	catch (cause) {
		const error = new CompactionSideEffectError(operation, cause);
		notice("warning", error.message);
		return { status: "failed", error };
	}
}
