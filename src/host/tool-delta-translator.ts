import type { RunnerEvent, ThreadDelta } from "./types.ts";

/**
 * Translates tool execution events into BB thread deltas.
 */
export function buildToolItemShape(
	toolName: string,
	args: Record<string, unknown>,
	fallbackCwd: string,
): Record<string, unknown> {
	if (toolName === "bash") {
		return {
			type: "command",
			command: typeof args.command === "string" ? args.command : "",
			cwd: typeof args.cwd === "string" ? args.cwd : fallbackCwd,
		};
	}

	if (toolName === "write") {
		const filePath = typeof args.path === "string" ? args.path : "";
		const newText = typeof args.content === "string" ? args.content : undefined;
		return {
			type: "fileChange",
			changes: filePath
				? [{ path: filePath, kind: "add", ...(newText !== undefined ? { newText } : {}) }]
				: [],
		};
	}

	if (toolName === "edit") {
		const filePath = typeof args.path === "string" ? args.path : "";
		if (!filePath) {
			return { type: "fileChange", changes: [] };
		}
		const edits = Array.isArray(args.edits) ? args.edits : [];
		if (edits.length > 0) {
			const changes = edits.map((edit: any) => ({
				path: filePath,
				kind: "update",
				...(typeof edit?.oldText === "string" ? { oldText: edit.oldText } : {}),
				...(typeof edit?.newText === "string" ? { newText: edit.newText } : {}),
			}));
			return { type: "fileChange", changes };
		}
		return {
			type: "fileChange",
			changes: [{ path: filePath, kind: "update" }],
		};
	}

	return {
		type: "tool",
		tool: toolName,
		server: "pi",
		args,
	};
}

export function translateToolStart(
	event: RunnerEvent,
	fallbackCwd: string,
): { shape: Record<string, unknown>; delta: ThreadDelta } {
	const callId = String(event.toolCallId);
	const toolName = String(event.toolName);
	const args = (event.args && typeof event.args === "object" ? event.args : {}) as Record<string, unknown>;
	const shape = buildToolItemShape(toolName, args, fallbackCwd);

	const delta: ThreadDelta = {
		kind: "item.open",
		key: { providerItemId: callId },
		item: shape,
	};
	return { shape, delta };
}

export function translateToolUpdate(event: RunnerEvent): ThreadDelta | null {
	const callId = String(event.toolCallId);
	const toolName = String(event.toolName);
	if (!event.partialResult) return null;

	if (toolName === "bash") {
		return {
			kind: "command.outputSnapshot",
			key: { providerItemId: callId },
			text: String(event.partialResult),
		};
	}

	return {
		kind: "item.progress",
		key: { providerItemId: callId },
		message: String(event.partialResult),
	};
}

export function translateToolEnd(
	event: RunnerEvent,
	cachedShape?: Record<string, unknown>,
	fallbackCwd = process.cwd(),
): ThreadDelta {
	const callId = String(event.toolCallId);
	const toolName = String(event.toolName);
	const shape = cachedShape ?? {
		type: toolName === "bash" ? "command" : "tool",
		...(toolName === "bash"
			? { command: "", cwd: fallbackCwd }
			: { tool: toolName, server: "pi" }),
	};

	const resultText = typeof event.result === "string"
		? event.result
		: JSON.stringify(event.result ?? "");

	return {
		kind: "item.close",
		key: { providerItemId: callId },
		status: event.isError ? "failed" : "completed",
		exitCode: event.isError ? 1 : 0,
		resultText,
		aggregatedOutput: shape.type === "command" ? resultText : undefined,
		item: shape,
	};
}
