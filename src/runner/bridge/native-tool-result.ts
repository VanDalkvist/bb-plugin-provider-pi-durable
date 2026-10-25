import type {
	AgentEvent,
	EntryRecord,
	NestedToolExecutionResult,
	ToolDiagnostic,
} from "@earendil-works/pi-durable";

export type NativeToolEndEvent = Extract<AgentEvent, { type: "tool_execution_end" }>;
export type NativeToolUpdateEvent = Extract<AgentEvent, { type: "tool_execution_update" }>;

export interface RawToolResultMessage {
	role?: string;
	isError?: boolean;
	output?: unknown;
	content?: unknown;
	details?: unknown;
	[key: string]: unknown;
}

export type NativeDecodedOutcome =
	| { status: "entry"; isError: boolean; rawOutput: unknown; details?: unknown }
	| { status: "result"; isError: boolean; rawOutput: unknown; details?: unknown; diagnostics: readonly ToolDiagnostic[] }
	| { status: "missing"; isError: true; errorMessage: string }
	| { status: "invalid"; isError: true; errorMessage: string };

export function extractCanonicalToolDetails(event: unknown): unknown {
	if (typeof event !== "object" || event === null) return undefined;
	const rec = event as {
		details?: unknown;
		result?: NestedToolExecutionResult;
		entry?: EntryRecord;
	};
	if (rec.result && typeof rec.result === "object" && "details" in rec.result) {
		return rec.result.details;
	}
	if (rec.entry && typeof rec.entry === "object" && Array.isArray(rec.entry.model)) {
		const msg = rec.entry.model[0] as RawToolResultMessage | undefined;
		if (msg && typeof msg === "object" && "details" in msg) {
			return msg.details;
		}
	}
	if ("details" in rec) {
		return rec.details;
	}
	return undefined;
}

function decodeEntry(entry: EntryRecord): NativeDecodedOutcome {
	const msg = entry.model?.[0] as RawToolResultMessage | undefined;
	if (!msg || typeof msg !== "object" || msg.role !== "toolResult") {
		return {
			status: "invalid",
			isError: true,
			errorMessage: "Tool execution entry is missing a valid toolResult message",
		};
	}
	return {
		status: "entry",
		isError: Boolean(msg.isError),
		rawOutput: msg.content ?? msg.output,
		details: "details" in msg ? msg.details : undefined,
	};
}

function decodeResult(result: NestedToolExecutionResult): NativeDecodedOutcome {
	return {
		status: "result",
		isError: Boolean(result.isError),
		rawOutput: result.structuredOutput,
		details: "details" in result ? result.details : undefined,
		diagnostics: result.diagnostics ?? [],
	};
}

export function decodeNativeToolEnd(event: {
	entry?: EntryRecord;
	result?: NestedToolExecutionResult;
}): NativeDecodedOutcome {
	const hasEntry = event.entry !== undefined;
	const hasResult = event.result !== undefined;

	if (hasEntry && hasResult) {
		return {
			status: "invalid",
			isError: true,
			errorMessage: "Tool protocol invariant violation: both entry and result present in tool_execution_end",
		};
	}
	if (!hasEntry && !hasResult) {
		return {
			status: "missing",
			isError: true,
			errorMessage: "Tool execution completed without generating an entry record or nested result",
		};
	}
	if (hasResult && event.result) {
		return decodeResult(event.result);
	}
	if (event.entry) {
		return decodeEntry(event.entry);
	}
	return {
		status: "invalid",
		isError: true,
		errorMessage: "Tool execution entry is missing",
	};
}
