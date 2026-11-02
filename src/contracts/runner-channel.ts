import { z } from "zod";

export const runnerChannelSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("ready"), ready: z.boolean().optional() }).passthrough(),
	z.object({ kind: z.literal("model-scope"), scopedModelIds: z.array(z.string()).optional(), defaultModelId: z.string().optional() }).passthrough(),
	z.object({ kind: z.literal("reply"), id: z.union([z.string(), z.number()]), result: z.unknown().optional(), error: z.unknown().optional() }).passthrough(),
	z.object({
		kind: z.literal("tool_call_request"),
		callId: z.string(),
		toolName: z.string(),
		arguments: z.unknown().default({}),
	}).passthrough(),
	z.object({
		kind: z.literal("tool_call_response"),
		callId: z.string(),
		result: z.unknown().optional(),
		isError: z.boolean().optional(),
	}).passthrough(),
	z.object({
		kind: z.literal("interaction_request"),
		id: z.union([z.string(), z.number()]),
		interactionKind: z.string().optional(),
		dialogKind: z.string().optional(),
		title: z.string().optional(),
		message: z.string().optional(),
		data: z.unknown().optional(),
	}).passthrough(),
	z.object({
		kind: z.literal("interaction_response"),
		id: z.union([z.string(), z.number()]),
		result: z.unknown().optional(),
		error: z.unknown().optional(),
	}).passthrough(),
]);

export const runnerBridgeRequestSchema = z.object({
	kind: z.literal("request"),
	id: z.union([z.string(), z.number()]),
	method: z.string(),
	params: z.unknown().optional(),
}).passthrough();

export type RunnerChannelFrame = z.infer<typeof runnerChannelSchema>;
export const knownChannelKinds: ReadonlySet<string> = new Set(runnerChannelSchema.options.map((schema) => schema.shape.kind.value));
