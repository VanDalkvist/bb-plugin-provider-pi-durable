import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { ToolDiagnostic } from "@earendil-works/pi-durable";

function isImageContent(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const rec = value as Record<string, unknown>;
	return rec.type === "image" && (typeof rec.data === "string" || typeof rec.mimeType === "string");
}

function redactImageStructures(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return value;
	if (isImageContent(value)) {
		const rec = value as Record<string, unknown>;
		return { ...rec, data: "[image data omitted]" };
	}
	if (Array.isArray(value)) {
		return value.map(redactImageStructures);
	}
	const result: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		result[k] = redactImageStructures(v);
	}
	return result;
}

function formatContentBlock(block: unknown): string {
	if (typeof block === "string") return block;
	if (typeof block !== "object" || block === null) return String(block);
	const rec = block as Record<string, unknown>;
	if (typeof rec.text === "string") return rec.text;
	if (isImageContent(rec)) {
		return `[image: ${String(rec.mimeType ?? "image")}]`;
	}
	return JSON.stringify(redactImageStructures(rec));
}

function formatRawOutput(toolName: string, raw: unknown): string {
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean" || raw === null) {
		return String(raw);
	}
	if (Array.isArray(raw)) {
		return raw.map(formatContentBlock).filter(Boolean).join("\n");
	}
	if (typeof raw === "object" && raw !== null) {
		const rec = raw as Record<string, unknown>;
		if (toolName === "bash" && typeof rec.output === "string") {
			return rec.output;
		}
		if (isImageContent(rec)) {
			return `[image: ${String(rec.mimeType ?? "image")}]`;
		}
		return JSON.stringify(redactImageStructures(raw), null, 2);
	}
	return "";
}

function renderDiagnostics(diagnostics: readonly ToolDiagnostic[]): string {
	return diagnostics
		.filter((d) => d && typeof d.message === "string" && d.message.length > 0)
		.map((d) => (d.severity && d.severity !== "info" ? `[${d.severity}] ${d.message}` : d.message))
		.join("\n");
}

export function presentToolResult(params: {
	toolName: string;
	rawOutput: unknown;
	isError: boolean;
	diagnostics?: readonly ToolDiagnostic[];
	retainedOutput?: string;
}): string {
	const { toolName, rawOutput, isError, diagnostics, retainedOutput } = params;
	let text = "";

	if (rawOutput !== undefined) {
		text = formatRawOutput(toolName, rawOutput);
	} else if (retainedOutput) {
		text = retainedOutput;
	}

	if (diagnostics && diagnostics.length > 0) {
		const diagText = renderDiagnostics(diagnostics);
		if (diagText) {
			text = text ? `${text}\n${diagText}` : diagText;
		}
	}

	if (!text && isError) {
		text = `Tool ${toolName} failed`;
	}

	return truncateTail(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	}).content;
}
