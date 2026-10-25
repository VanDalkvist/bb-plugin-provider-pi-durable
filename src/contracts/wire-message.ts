import { z } from "zod";
import { wireContextSchema } from "./wire-context.ts";

const number = z.number().optional();
export const assistantUsageSchema = z.object({
 input: number, output: number, cacheRead: number, cacheWrite: number, totalTokens: number,
 cost: z.object({ input: number, output: number, cacheRead: number, cacheWrite: number, total: number }).passthrough().optional(),
}).passthrough();
export type BBAssistantMessageUsage = z.infer<typeof assistantUsageSchema>;
export const assistantMessageSchema = z.object({
 role: z.literal("assistant"),
 content: z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), thinking: z.string() }),
  z.object({ type: z.literal("toolCall"), id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
 ])),
 stopReason: z.enum(["stop", "toolUse", "length", "aborted", "error"]).optional(),
 errorMessage: z.string().optional(), usage: assistantUsageSchema.optional(),
}).passthrough();
export type BBAssistantMessage = z.infer<typeof assistantMessageSchema>;
const contentIndex = z.number().int().nonnegative();
const update = z.discriminatedUnion("type", [
 z.object({ type: z.literal("thinking_delta"), contentIndex, delta: z.string() }).passthrough(),
 z.object({ type: z.literal("thinking_end"), contentIndex, content: z.string() }).passthrough(),
 z.object({ type: z.literal("text_delta"), contentIndex, delta: z.string() }).passthrough(),
 z.object({ type: z.literal("thinking_start"), contentIndex }).passthrough(),
 z.object({ type: z.literal("text_start"), contentIndex }).passthrough(),
 z.object({ type: z.literal("text_end"), contentIndex, content: z.string() }).passthrough(),
]);
export const messageUpdateSchema = wireContextSchema.extend({ type: z.literal("message_update"), assistantMessageEvent: update });
export const messageSchemas = [
 messageUpdateSchema,
 wireContextSchema.extend({ type: z.literal("message_end"), message: assistantMessageSchema }),
] as const;
export type BBMessageUpdateEvent = z.infer<typeof messageUpdateSchema>;
