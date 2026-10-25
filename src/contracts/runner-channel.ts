import { z } from "zod";

export const runnerChannelSchema = z.discriminatedUnion("kind", [
 z.object({ kind: z.literal("ready"), ready: z.boolean().optional() }).passthrough(),
 z.object({ kind: z.literal("model-scope"), scopedModelIds: z.array(z.string()).optional(), defaultModelId: z.string().optional() }).passthrough(),
 z.object({ kind: z.literal("reply"), id: z.union([z.string(), z.number()]), result: z.unknown().optional(), error: z.unknown().optional() }).passthrough(),
]);
export const runnerBridgeRequestSchema = z.object({
 kind: z.literal("request"), id: z.union([z.string(), z.number()]), method: z.string(), params: z.unknown().optional(),
}).passthrough();
export type RunnerChannelFrame = z.infer<typeof runnerChannelSchema>;
export const knownChannelKinds : ReadonlySet<string> = new Set(runnerChannelSchema.options.map((schema) => schema.shape.kind.value));
