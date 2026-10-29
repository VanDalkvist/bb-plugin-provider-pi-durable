import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";

export class InvalidSubagentMirrorEnvelopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidSubagentMirrorEnvelopeError";
	}
}

export type ParsedSubagentMirrorPrompt =
	| {
			isMirror: true;
			sessionKey: string;
			parentThreadId: string;
			conversationId: string;
			task: string;
	  }
	| {
			isMirror: false;
			task: string;
	  };

const RESERVED_PREFIX = "[bb:pi-subagent-mirror:";
const ROOT_CONV_STR = String(ROOT_CONVERSATION_ID);
const ENVELOPE_REGEX = /^\s*\[bb:pi-subagent-mirror:v1\s+session=([^\s\]]+)\s+parent=([^\s\]]+)\s+conv=([^\s\]]+)\]\s*(?:\r?\n)?([\s\S]*)$/u;
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_SESSION_KEY_REGEX = /^(?!\.)(?!.*\.\.)[a-zA-Z0-9._-]{1,128}$/;

export function formatSubagentMirrorPrompt(
	sessionKey: string,
	parentThreadId: string,
	conversationId: string | number,
	task: string,
): string {
	const s = sessionKey.trim();
	const p = parentThreadId.trim();
	const c = String(conversationId).trim();
	return `[bb:pi-subagent-mirror:v1 session=${s} parent=${p} conv=${c}]\n${task.trim()}`;
}

export function parseSubagentMirrorPrompt(input: string): ParsedSubagentMirrorPrompt {
	if (typeof input !== "string") {
		return { isMirror: false, task: "" };
	}
	const trimmed = input.trimStart();
	if (!trimmed.startsWith(RESERVED_PREFIX)) {
		return { isMirror: false, task: input };
	}

	const match = ENVELOPE_REGEX.exec(input);
	if (!match) {
		throw new InvalidSubagentMirrorEnvelopeError(
			`Invalid or unsupported subagent mirror envelope syntax in prompt: ${trimmed.slice(0, 80)}`,
		);
	}

	const sessionKey = match[1]?.trim();
	const parentThreadId = match[2]?.trim();
	const conversationId = match[3]?.trim();
	const task = match[4]?.trim() ?? "";

	if (!sessionKey || !parentThreadId || !conversationId) {
		throw new InvalidSubagentMirrorEnvelopeError(
			"Subagent mirror envelope requires non-empty session, parent, and conv fields",
		);
	}

	if (!SAFE_SESSION_KEY_REGEX.test(sessionKey)) {
		throw new InvalidSubagentMirrorEnvelopeError(
			`Invalid characters in subagent mirror sessionKey: "${sessionKey}"`,
		);
	}

	if (!SAFE_ID_REGEX.test(parentThreadId)) {
		throw new InvalidSubagentMirrorEnvelopeError(
			`Invalid characters in subagent mirror parentThreadId: "${parentThreadId}"`,
		);
	}

	if (!/^[1-9][0-9]*$/.test(conversationId) || Number(conversationId) < 2) {
		throw new InvalidSubagentMirrorEnvelopeError(
			`Invalid subagent mirror conversationId: "${conversationId}". Must be a canonical positive integer >= 2`,
		);
	}

	return {
		isMirror: true,
		sessionKey,
		parentThreadId,
		conversationId,
		task,
	};
}

export function stripSubagentMirrorEnvelope(input: string): string {
	const parsed = parseSubagentMirrorPrompt(input);
	return parsed.task;
}
