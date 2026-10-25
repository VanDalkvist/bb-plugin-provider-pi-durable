import { z } from "zod";
import { wireContextSchema } from "./wire-context.ts";
import { assistantMessageSchema } from "./wire-message.ts";

export const planStepSchema = z.object({
 step: z.string(), status: z.enum(["pending", "active", "completed", "failed"]),
}).passthrough();
export type BBPlanStep = z.infer<typeof planStepSchema>;
export const tasksSnapshotSchema = wireContextSchema.extend({ type: z.literal("tasks_snapshot"), steps: z.array(planStepSchema) });
export type BBTasksSnapshotEvent = z.infer<typeof tasksSnapshotSchema>;
export const lifecycleSchemas = [
 wireContextSchema.extend({ type: z.literal("agent_start") }),
 wireContextSchema.extend({ type: z.literal("context_window"), usedTokens: z.number().nullable().optional(), contextWindow: z.number() }),
 wireContextSchema.extend({ type: z.literal("turn_start") }),
 wireContextSchema.extend({ type: z.literal("turn_end"), message: assistantMessageSchema.optional(), contextWindow: z.number().optional() }),
 wireContextSchema.extend({ type: z.literal("agent_end"), messages: z.array(assistantMessageSchema), contextWindow: z.number().optional() }),
 wireContextSchema.extend({ type: z.literal("compaction_start"), reason: z.enum(["manual", "threshold"]) }),
 wireContextSchema.extend({ type: z.literal("compaction_end"), reason: z.enum(["manual", "threshold"]), aborted: z.boolean() }),
 wireContextSchema.extend({ type: z.literal("auto_retry_start"), attempt: z.number(), at: z.number().optional() }),
 wireContextSchema.extend({ type: z.literal("auto_retry_end"), attempt: z.number(), success: z.boolean().optional() }),
 tasksSnapshotSchema,
] as const;
export const sessionStatsSchema = z.object({ contextUsage: z.object({ tokens: z.number().nullable(), contextWindow: z.number() }) });
export type BBSessionStatsData = z.infer<typeof sessionStatsSchema>;
