import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { promptInputSchema } from "./types.ts";

export interface PiPromptImage {
	type: "image";
	data: string;
	mimeType: string;
}

export interface PiPromptInput {
	text: string;
	images: PiPromptImage[];
}

function mimeTypeFromExtension(filePath: string): string {
	switch (extname(filePath).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".svg":
			return "image/svg+xml";
		default:
			return "image/png";
	}
}

function decodeImageDataUrl(url: string): { data: string; mimeType: string } | null {
	const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
	if (!match) return null;
	const [, mimeType, data] = match;
	return data.length > 0 ? { data, mimeType } : null;
}

export function extractPiPromptInput(input: unknown): PiPromptInput | null {
	const parsed = promptInputSchema.safeParse(input);
	if (!parsed.success) return null;

	const textParts: string[] = [];
	const images: PiPromptImage[] = [];
	const commandMentions: Array<{ chunkIndex: number; start: number; end: number; name: string }> = [];

	for (const chunk of parsed.data) {
		if (chunk.type === "text") {
			const chunkIndex = textParts.push(chunk.text) - 1;
			if (Array.isArray(chunk.mentions)) {
				for (const mention of chunk.mentions) {
					const resource = mention.resource;
					if (
						resource?.kind === "command" &&
						resource?.source === "skill" &&
						(resource?.trigger === "/" || resource?.trigger === "$") &&
						typeof resource?.name === "string" &&
						mention.start < mention.end &&
						mention.end <= chunk.text.length &&
						chunk.text.slice(mention.start, mention.end) === `${resource.trigger}${resource.name}`
					) {
						commandMentions.push({
							chunkIndex,
							end: mention.end,
							name: resource.name,
							start: mention.start,
						});
					}
				}
			}
		} else if (chunk.type === "localImage") {
			try {
				if (existsSync(chunk.path)) {
					const buf = readFileSync(chunk.path);
					images.push({
						type: "image",
						data: buf.toString("base64"),
						mimeType: mimeTypeFromExtension(chunk.path),
					});
				}
			} catch (err) {
				console.warn(`[PromptInput] Failed to read local image at ${chunk.path}:`, err);
			}
		} else if (chunk.type === "image") {
			if (typeof chunk.url === "string" && chunk.url.startsWith("data:")) {
				const decoded = decodeImageDataUrl(chunk.url);
				if (decoded) {
					images.push({
						type: "image",
						data: decoded.data,
						mimeType: decoded.mimeType,
					});
				}
			}
		} else if (chunk.type === "localFile") {
			const name = (chunk as any).name;
			textParts.push(name ? `[Attached file "${name}": ${chunk.path}]` : `[Attached file: ${chunk.path}]`);
		}
	}

	const [singleCommand] = commandMentions;
	if (commandMentions.length === 1 && singleCommand) {
		const chunkText = textParts[singleCommand.chunkIndex];
		if (chunkText !== undefined) {
			textParts[singleCommand.chunkIndex] = `${chunkText.slice(0, singleCommand.start)}${chunkText.slice(singleCommand.end)}`;
			const fullText = textParts.join("\n");
			const space = fullText.startsWith(" ") ? "" : " ";
			return {
				text: `/skill:${singleCommand.name}${fullText ? `${space}${fullText}` : ""}`,
				images,
			};
		}
	}

	const trimmedText = textParts.join("\n").trim();
	if (!trimmedText && images.length === 0) {
		return null;
	}
	return {
		text: textParts.join("\n"),
		images,
	};
}

export function extractInputText(input: unknown): string {
	const promptInput = extractPiPromptInput(input);
	return promptInput?.text ?? "";
}

export function isCompactCommand(input: unknown): boolean {
	if (!Array.isArray(input)) return false;
	for (const chunk of input) {
		if (chunk && typeof chunk === "object" && chunk.type === "text") {
			if (Array.isArray(chunk.mentions)) {
				for (const mention of chunk.mentions) {
					if (
						mention?.resource?.kind === "command" &&
						mention?.resource?.trigger === "/" &&
						mention?.resource?.name === "compact"
					) {
						return true;
					}
				}
			}
			if (typeof chunk.text === "string" && /(?:^|\n)\s*\/compact(?:\s|$)/m.test(chunk.text)) {
				return true;
			}
		}
	}
	return false;
}

export function extractCompactInstructions(input: unknown): string | undefined {
	if (!Array.isArray(input)) return undefined;
	for (const chunk of input) {
		if (chunk && typeof chunk === "object" && chunk.type === "text" && typeof chunk.text === "string") {
			const match = /(?:^|\n)\s*\/compact(?:\s+(.*))?$/m.exec(chunk.text);
			if (match) {
				const instructions = (match[1] || "").trim();
				return instructions || undefined;
			}
		}
	}
	return undefined;
}
