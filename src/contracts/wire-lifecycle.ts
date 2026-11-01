import { z } from "zod";
import { wireContextSchema } from "./wire-context.ts";
import { assistantMessageSchema } from "./wire-message.ts";
import { runtimeGraphSnapshotSchema } from "../runtime-graph/schema.ts";

export const runtimeGraphSnapshotEventSchema = wireContextSchema.extend({
	type: z.literal("runtime_graph_snapshot"),
	snapshot: runtimeGraphSnapshotSchema,
});
export type RuntimeGraphSnapshotEvent = z.infer<typeof runtimeGraphSnapshotEventSchema>;

export const lifecycleSchemas = [
	wireContextSchema.extend({ type: z.literal("agent_start") }),
	wireContextSchema.extend({ type: z.literal("context_window"), usedTokens: z.number().nullable().optional(), contextWindow: z.number() }),
	wireContextSchema.extend({ type: z.literal("turn_start") }),
	wireContextSchema.extend({ type: z.literal("turn_end"), message: assistantMessageSchema.optional(), contextWindow: z.number().optional() }),
	wireContextSchema.extend({ type: z.literal("agent_end"), messages: z.array(assistantMessageSchema), message: assistantMessageSchema.optional(), contextWindow: z.number().optional() }),
	wireContextSchema.extend({ type: z.literal("compaction_start"), reason: z.enum(["manual", "threshold"]) }),
	wireContextSchema.extend({ type: z.literal("compaction_end"), reason: z.enum(["manual", "threshold"]), aborted: z.boolean() }),
	wireContextSchema.extend({ type: z.literal("auto_retry_start"), attempt: z.number(), at: z.number().optional() }),
	wireContextSchema.extend({ type: z.literal("auto_retry_end"), attempt: z.number(), success: z.boolean().optional() }),
	runtimeGraphSnapshotEventSchema,
] as const;

export const sessionStatsSchema = z.object({ contextUsage: z.object({ tokens: z.number().nullable(), contextWindow: z.number() }) });
export type SessionStatsData = z.infer<typeof sessionStatsSchema>;
