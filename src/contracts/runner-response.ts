import { z } from "zod";

const base = z.object({ id: z.string().optional(), type: z.literal("response"), command: z.string().min(1) });
export const runnerResponseSchema = z.discriminatedUnion("success", [
 base.extend({ success: z.literal(true), data: z.unknown().optional() }).passthrough(),
 base.extend({ success: z.literal(false), error: z.string() }).passthrough(),
]);
export type RunnerResponse = z.infer<typeof runnerResponseSchema>;
