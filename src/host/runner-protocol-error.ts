import { runnerEventSchema, knownEventTypes } from "../contracts/runner-event.ts";
import { runnerResponseSchema } from "../contracts/runner-response.ts";
import { runnerChannelSchema, knownChannelKinds } from "../contracts/runner-channel.ts";

export type ProtocolCode = "MALFORMED_JSON" | "INVALID_MESSAGE" | "MISMATCHED_RESPONSE" | "FRAME_TOO_LARGE" | "CONSUMER_FAILURE";
export class RunnerProtocolError extends Error {
	readonly code: ProtocolCode;
	constructor(code: ProtocolCode, cause?: unknown) {
		super(`Runner protocol fault: ${code}`, { cause });
		this.name = "RunnerProtocolError";
		this.code = code;
	}
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseProtocolJson(line: string): unknown {
	try { return JSON.parse(line); }
	catch (cause) { throw new RunnerProtocolError("MALFORMED_JSON", cause); }
}

export function decodeStdout(value: unknown) {
	if (!object(value) || typeof value.type !== "string") throw new RunnerProtocolError("INVALID_MESSAGE");
	if (value.type === "response") {
		const result = runnerResponseSchema.safeParse(value);
		if (!result.success) throw new RunnerProtocolError("INVALID_MESSAGE", result.error);
		return result.data;
	}
	if (!knownEventTypes.has(value.type)) return undefined;
	const result = runnerEventSchema.safeParse(value);
	if (!result.success) throw new RunnerProtocolError("INVALID_MESSAGE", result.error);
	return result.data;
}

export function runnerProtocolWarning(error: RunnerProtocolError): import("@get-bb/plugin-sdk/provider-bridge").ThreadDelta {
	return { kind: "provider.warning", category: "general", summary: "Runner observation channel failed", details: `${error.code}. Native task outcomes are not inferred. Further requests require recovery; no input is replayed.` };
}

export function decodeChannel(value: unknown) {
	if (!object(value) || typeof value.kind !== "string") throw new RunnerProtocolError("INVALID_MESSAGE");
	if (!knownChannelKinds.has(value.kind)) return undefined;
	const result = runnerChannelSchema.safeParse(value);
	if (!result.success) throw new RunnerProtocolError("INVALID_MESSAGE", result.error);
	return result.data;
}
