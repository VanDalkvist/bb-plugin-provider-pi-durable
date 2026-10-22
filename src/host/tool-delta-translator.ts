import type { RunnerEvent, ThreadDelta } from "./types.ts";
import {
	normalizeFilePath,
	synthesizeAddDiff,
	normalizeGitPatch,
	resolveFileChangeItem,
} from "./diff-utils.ts";
import {
	isDelegationTool,
	getDelegationPresentation,
	extractCodemodeTitle,
	getCodemodePresentation,
	resolveToolPresentation,
} from "./tool-presentations.ts";
import { buildToolItemShape } from "./tool-item-shape.ts";

export {
	normalizeFilePath,
	synthesizeAddDiff,
	normalizeGitPatch,
	resolveFileChangeItem,
	isDelegationTool,
	getDelegationPresentation,
	extractCodemodeTitle,
	getCodemodePresentation,
	resolveToolPresentation,
	buildToolItemShape,
};

function resolveSafeParentRef(
	rawParentRef: unknown,
	parentShape?: Record<string, unknown>,
): string | undefined {
	if (!rawParentRef) return undefined;
	const refStr = String(rawParentRef);
	if (parentShape?.tool === "codemode" || (parentShape && parentShape.type !== "delegation")) {
		return undefined;
	}
	return refStr;
}

export function translateToolStart(
	event: RunnerEvent,
	fallbackCwd: string,
	parentShape?: Record<string, unknown>,
): { shape: Record<string, unknown>; delta: ThreadDelta } {
	const callId = String(event.toolCallId);
	const toolName = String(event.toolName);
	const args = (event.args && typeof event.args === "object" ? event.args : {}) as Record<string, unknown>;
	const shape = buildToolItemShape(toolName, args, fallbackCwd);
	const presentation = resolveToolPresentation(toolName, shape, args);
	const parentRef = resolveSafeParentRef(event.parentRef ?? event.parentToolCallId, parentShape);

	const delta: ThreadDelta = {
		kind: "item.open",
		key: {
			providerItemId: callId,
			...(parentRef ? { parentRef } : {}),
		},
		item: {
			...shape,
			...(parentRef ? { parentToolCallId: parentRef } : {}),
		},
		...(presentation ? { presentation } : {}),
	};
	return { shape, delta };
}

export function translateToolUpdate(
	event: RunnerEvent,
	parentShape?: Record<string, unknown>,
): ThreadDelta | null {
	const callId = String(event.toolCallId);
	const toolName = String(event.toolName);
	const parentRef = resolveSafeParentRef(event.parentRef ?? event.parentToolCallId, parentShape);
	if (!event.partialResult) return null;

	if (toolName === "bash") {
		return {
			kind: "command.outputSnapshot",
			key: {
				providerItemId: callId,
				...(parentRef ? { parentRef } : {}),
			},
			text: String(event.partialResult),
		};
	}

	return {
		kind: "item.progress",
		key: {
			providerItemId: callId,
			...(parentRef ? { parentRef } : {}),
		},
		message: String(event.partialResult),
	};
}

export function translateToolEnd(
	event: RunnerEvent,
	cachedShape?: Record<string, unknown>,
	fallbackCwd = process.cwd(),
	parentShape?: Record<string, unknown>,
): ThreadDelta {
	const callId = String(event.toolCallId);
	const toolName = String(event.toolName);
	const isDelegation = isDelegationTool(toolName);
	const shape = cachedShape ?? {
		type: toolName === "bash" ? "command" : isDelegation ? "delegation" : "tool",
		...(toolName === "bash"
			? { command: "", cwd: fallbackCwd }
			: isDelegation
				? { childRef: "agent", label: "Agent delegation", background: false }
				: { tool: toolName, server: "pi" }),
	};

	const resultText = typeof event.result === "string"
		? event.result
		: JSON.stringify(event.result ?? "");

	const isError = Boolean(event.isError);

	let item = shape;
	if (item.type === "fileChange") {
		item = resolveFileChangeItem(item, event, fallbackCwd);
	} else if (item.type === "tool" && isError) {
		item = {
			...item,
			error: resultText,
		};
	} else if (item.type === "delegation") {
		const detailsObj = typeof event.details === "object" && event.details !== null
			? (event.details as Record<string, unknown>)
			: undefined;
		const conversationId = detailsObj?.conversationId;
		const childRef = conversationId !== undefined && conversationId !== null && String(conversationId).trim() !== ""
			? String(conversationId)
			: (typeof item.childRef === "string" && item.childRef ? item.childRef : "subagent");
		const summary = resultText
			? (resultText.length > 300 ? `${resultText.slice(0, 297)}...` : resultText)
			: (typeof item.summary === "string" ? item.summary : undefined);
		const background = detailsObj?.background !== undefined
			? Boolean(detailsObj.background)
			: (item.background ?? true);
		item = {
			...item,
			childRef,
			summary,
			background,
		};
	}

	const presentation = resolveToolPresentation(
		toolName,
		item,
		typeof item.args === "object" && item.args ? (item.args as Record<string, unknown>) : undefined,
	);
	const parentRef = resolveSafeParentRef(event.parentRef ?? event.parentToolCallId, parentShape);

	return {
		kind: "item.close",
		key: {
			providerItemId: callId,
			...(parentRef ? { parentRef } : {}),
		},
		status: isError ? "failed" : "completed",
		exitCode: isError ? 1 : 0,
		resultText,
		aggregatedOutput: item.type === "command" ? resultText : undefined,
		...(isError ? { error: { message: resultText } } : {}),
		item: {
			...item,
			...(parentRef ? { parentToolCallId: parentRef } : {}),
		},
		...(presentation ? { presentation } : {}),
	};
}
