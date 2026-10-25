import { z } from "zod";
import { conversationIdSchema } from "./wire-context.ts";

export interface CommandResponder {
	success: (id: string | undefined, command: string, data?: unknown) => void;
	error: (id: string | undefined, command: string, message: string) => void;
}

export const runnerCommandSchema = z.object({
	type: z.enum(["prompt", "steer", "abort", "compact", "set_subagent_policy", "get_available_models", "set_model", "set_thinking_level", "get_state", "get_session_stats", "register_binding", "get_all_bindings"]),
	id: z.string().optional(), message: z.string().optional(),
	images: z.array(z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() })).optional(),
	streamingBehavior: z.enum(["steer", "followUp"]).optional(),
	provider: z.string().optional(), modelId: z.string().optional(), instructions: z.string().optional(),
	level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
	conversationId: conversationIdSchema.optional(), bbThreadId: z.string().optional(),
	parentThreadId: z.string().optional(), sessionId: z.string().optional(), policyRecord: z.unknown().optional(),
}).passthrough();
export type RunnerCommandPayload = z.infer<typeof runnerCommandSchema>;
export const knownCommandTypes: ReadonlySet<string> = new Set(runnerCommandSchema.shape.type.options);
// The generic transport also serves explicitly injected probe backends; native dispatch remains the closed schema above.
export const runnerRequestHeaderSchema = z.object({ type: z.string().min(1), id: z.string().optional() }).passthrough();

export function parseRunnerCommand(line: string): RunnerCommandPayload {
	let value: unknown;
	try { value = JSON.parse(line); }
	catch (cause) { throw new Error("INVALID_COMMAND_JSON", { cause }); }
	const parsed = runnerCommandSchema.safeParse(value);
	if (!parsed.success) throw new Error("INVALID_COMMAND", { cause: parsed.error });
	return parsed.data;
}
