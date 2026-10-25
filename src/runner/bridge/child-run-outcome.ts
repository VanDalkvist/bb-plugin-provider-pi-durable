export interface ChildRunOutcome {
	status: "completed" | "failed" | "interrupted";
	isAborted?: boolean;
	isError?: boolean;
	errorMessage?: string;
}

export function resolveChildRunOutcome(
	inputs?: readonly (string | number)[],
	submissions?: Map<string | number, { status: string; reason?: string; detail?: string }>,
	lastTaskError?: string,
): ChildRunOutcome {
	if (inputs && submissions) {
		let hasDoneInput = false;
		for (const id of inputs) {
			const sub = submissions.get(id);
			if (sub) {
				if (sub.status === "done") {
					hasDoneInput = true;
				} else if (sub.status === "unanswered") {
					const isAborted = sub.reason === "aborted" || sub.reason === "cancelled";
					return {
						status: isAborted ? "interrupted" : "failed",
						isAborted,
						isError: !isAborted,
						errorMessage: sub.detail || sub.reason || lastTaskError || "Task failed",
					};
				}
			}
		}
		if (hasDoneInput) {
			return { status: "completed" };
		}
	}

	if (lastTaskError) {
		return {
			status: "failed",
			isError: true,
			errorMessage: lastTaskError,
		};
	}

	return { status: "completed" };
}
