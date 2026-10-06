/**
 * Translates tool execution events into BB thread deltas.
 */

export function buildToolItemShape(toolName: string, args: Record<string, any>, fallbackCwd: string): any {
	if (toolName === "bash") {
		return {
			type: "command",
			command: typeof args.command === "string" ? args.command : "",
			cwd: typeof args.cwd === "string" ? args.cwd : fallbackCwd,
		};
	}

	if (toolName === "edit" || toolName === "write") {
		const filePath = typeof args.path === "string" ? args.path : "";
		return {
			type: "fileChange",
			changes: filePath ? [{ path: filePath, kind: toolName === "write" ? "create" : "modify" }] : [],
		};
	}

	return {
		type: "tool",
		tool: toolName,
		server: "pi",
		args,
	};
}

export function translateToolStart(event: any, fallbackCwd: string): { shape: any; delta: any } {
	const callId = String(event.toolCallId);
	const toolName = String(event.toolName);
	const args = event.args ?? {};
	const shape = buildToolItemShape(toolName, args, fallbackCwd);

	const delta = {
		kind: "item.open",
		key: { providerItemId: callId },
		item: shape,
	};
	return { shape, delta };
}

export function translateToolUpdate(event: any): any | null {
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

export function translateToolEnd(event: any, cachedShape?: any, fallbackCwd = process.cwd()): any {
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
