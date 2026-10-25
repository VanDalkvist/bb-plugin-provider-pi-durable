import { z } from "zod";

export const conversationIdSchema = z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]);
export const cumulativeUsageSchema = z.object({
 totalTokens: z.number(), inputTokens: z.number(), outputTokens: z.number(),
 cachedInputTokens: z.number().optional(), cacheWriteInputTokens: z.number().optional(),
}).passthrough();
export type CumulativeUsageMetrics = z.infer<typeof cumulativeUsageSchema>;
export const wireContextSchema = z.object({
 parentRef: z.string().optional(), conversationId: conversationIdSchema.optional(),
 providerCheckpointId: z.string().optional(), cumulativeUsage: cumulativeUsageSchema.optional(),
 aborted: z.boolean().optional(), stopReason: z.string().optional(), errorMessage: z.string().optional(),
}).passthrough();
