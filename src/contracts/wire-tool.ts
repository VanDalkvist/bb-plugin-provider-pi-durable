import { z } from "zod";
import { wireContextSchema } from "./wire-context.ts";

const tool = wireContextSchema.extend({
 toolCallId: z.union([z.string().min(1), z.number().int().nonnegative()]), toolName: z.string().min(1),
});
export const toolStartSchema = tool.extend({ type: z.literal("tool_execution_start"), args: z.record(z.string(), z.unknown()) });
export const toolUpdateSchema = tool.extend({
 type: z.literal("tool_execution_update"), partialResult: z.string(), trimStart: z.number().optional(), details: z.unknown().optional(),
});
export const toolEndSchema = tool.extend({
 type: z.literal("tool_execution_end"), result: z.string(), isError: z.boolean(), details: z.unknown().optional(),
});
export const toolSchemas = [toolStartSchema, toolUpdateSchema, toolEndSchema] as const;
export type BBToolExecutionStartEvent = z.infer<typeof toolStartSchema>;
export type BBToolExecutionUpdateEvent = z.infer<typeof toolUpdateSchema>;
export type BBToolExecutionEndEvent = z.infer<typeof toolEndSchema>;
