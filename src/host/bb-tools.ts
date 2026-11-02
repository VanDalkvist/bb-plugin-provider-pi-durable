import { z } from "zod";

export const bbDynamicToolSchema = z.object({
	name: z.string().min(1),
	description: z.string().default(""),
	inputSchema: z.unknown().default({}),
	presentation: z.object({
		label: z.object({
			pending: z.string().optional(),
			completed: z.string().optional(),
		}).optional(),
		icon: z.object({ glyph: z.string().optional() }).optional(),
		suppress: z.boolean().optional(),
	}).optional(),
}).passthrough();

export type BbDynamicTool = z.infer<typeof bbDynamicToolSchema>;

export const bbToolCallRequestParamsSchema = z.object({
	threadId: z.string().min(1).optional(),
	providerThreadId: z.string().min(1),
	turnId: z.union([z.string().min(1), z.null()]).default(null),
	callId: z.string().min(1),
	tool: z.string().min(1),
	arguments: z.unknown().default({}),
});

export type BbToolCallRequestParams = z.infer<typeof bbToolCallRequestParamsSchema>;

export const bbContentItemSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("inputText"), text: z.string() }),
	z.object({ type: z.literal("inputImage"), imageUrl: z.string() }),
]);

export type BbContentItem = z.infer<typeof bbContentItemSchema>;

export const bbToolCallResponseSchema = z.object({
	contentItems: z.array(bbContentItemSchema).default([]),
	isError: z.boolean().optional(),
	error: z.object({ message: z.string().optional() }).optional(),
}).passthrough();

export type BbToolCallResponse = z.infer<typeof bbToolCallResponseSchema>;

export const bbInteractionRequestParamsSchema = z.object({
	threadId: z.string().min(1).optional(),
	providerThreadId: z.string().min(1),
	turnId: z.union([z.string().min(1), z.null()]).default(null),
	payload: z.object({
		kind: z.enum(["select", "confirm", "input", "editor", "notify"]),
		title: z.string().optional(),
		message: z.string().optional(),
		data: z.unknown().optional(),
	}),
});

export type BbInteractionRequestParams = z.infer<typeof bbInteractionRequestParamsSchema>;
