import type {
	BBToolExecutionEndEvent,
	BBToolExecutionUpdateEvent,
} from "./contracts.ts";
import {
	decodeNativeToolEnd,
	extractCanonicalToolDetails,
	type NativeToolEndEvent,
	type NativeToolUpdateEvent,
	type NativeDecodedOutcome,
	type RawToolResultMessage,
} from "./native-tool-result.ts";
import { presentToolResult } from "./tool-result-presentation.ts";
import { ToolProgressState, type ActiveToolSlot } from "./tool-progress-state.ts";

export { extractCanonicalToolDetails };
export type { NativeToolEndEvent, NativeToolUpdateEvent };

function buildTerminalError(
	event: NativeToolEndEvent,
	decoded: Extract<NativeDecodedOutcome, { isError: true }>,
	canonicalDetails: unknown,
	parentRef?: string,
): BBToolExecutionEndEvent {
	return {
		type: "tool_execution_end",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		result: decoded.errorMessage,
		isError: true,
		...(canonicalDetails !== undefined ? { details: canonicalDetails } : {}),
		...(parentRef !== undefined ? { parentRef } : {}),
	};
}

function buildTerminalSuccess(
	event: NativeToolEndEvent,
	decoded: Extract<NativeDecodedOutcome, { status: "entry" | "result" }>,
	scoped: { output?: string; details?: unknown },
	canonicalDetails: unknown,
	parentRef?: string,
): BBToolExecutionEndEvent {
	const details = canonicalDetails !== undefined ? canonicalDetails : scoped.details;
	const result = presentToolResult({
		toolName: event.toolName,
		rawOutput: decoded.rawOutput,
		isError: decoded.isError,
		diagnostics: decoded.status === "result" ? decoded.diagnostics : undefined,
		retainedOutput: scoped.output,
	});

	return {
		type: "tool_execution_end",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		result,
		isError: decoded.isError,
		...(details !== undefined ? { details } : {}),
		...(parentRef !== undefined ? { parentRef } : {}),
	};
}

export class ToolEventProjector {
	private readonly progressState = new ToolProgressState();

	public projectToolUpdate(
		event: NativeToolUpdateEvent,
		parentRef?: string,
	): BBToolExecutionUpdateEvent | undefined {
		let partialResult: string | undefined;
		if (event.output) {
			partialResult = this.progressState.applyOutputUpdate(event.toolCallId, event.output);
		} else if (event.details !== undefined) {
			partialResult = this.progressState.getRetainedOutput(event.toolCallId) ?? "";
		}
		if (event.details !== undefined) {
			this.progressState.setDetails(event.toolCallId, event.details);
		}
		let trimStart: number | undefined;
		if (event.output && "trimStart" in event.output && typeof event.output.trimStart === "number") {
			trimStart = event.output.trimStart;
		}

		if (partialResult !== undefined || trimStart !== undefined || event.details !== undefined) {
			return {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				partialResult: partialResult ?? "",
				...(trimStart !== undefined ? { trimStart } : {}),
				...(event.details !== undefined ? { details: event.details } : {}),
				...(parentRef !== undefined ? { parentRef } : {}),
			};
		}
		return undefined;
	}

	public projectToolEnd(
		event: NativeToolEndEvent,
		parentRef?: string,
	): BBToolExecutionEndEvent {
		const decoded = decodeNativeToolEnd(event);
		const scoped = this.progressState.take(event.toolCallId);
		const canonicalDetails = extractCanonicalToolDetails(event);

		if (decoded.status === "missing" || decoded.status === "invalid") {
			const fallback = canonicalDetails !== undefined ? canonicalDetails : scoped.details;
			return buildTerminalError(event, decoded, fallback, parentRef);
		}

		return buildTerminalSuccess(event, decoded, scoped, canonicalDetails, parentRef);
	}

	public clear(): void {
		this.progressState.clear();
	}

	public seedFromSnapshot(
		tools?: readonly { callId: string | number; output?: unknown; details?: unknown }[],
		nestedTools?: readonly { callId: string | number; output?: unknown; details?: unknown }[],
	): void {
		this.progressState.seedFromSnapshot(tools, nestedTools);
	}
}

export function extractToolResult(modelItem: unknown): { result: string; isError: boolean } {
	const msg = typeof modelItem === "object" && modelItem !== null ? (modelItem as RawToolResultMessage) : undefined;
	const isError = Boolean(msg?.isError);
	const raw = msg?.content ?? msg?.output;
	const result = presentToolResult({
		toolName: "tool",
		rawOutput: raw,
		isError,
	});
	return { result, isError };
}
