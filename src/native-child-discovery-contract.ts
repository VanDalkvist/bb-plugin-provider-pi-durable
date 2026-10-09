import { z } from "zod";

/** Public, read-only locator: never contains host credentials or authorization. */
export const NativeChildDiscoverySchema = z.object({
	parentThreadId: z.string().min(1).max(512),
	durableSessionId: z.string().min(1).max(512),
	parentConversationId: z.number().int().safe().nonnegative(),
	childConversationId: z.number().int().safe().nonnegative(),
	taskId: z.number().int().safe().nonnegative(),
	requestId: z.string().min(1).max(512),
	phase: z.enum(["intent", "submitted"]),
}).strict().refine((value) => value.requestId === `subagent:${value.taskId}`, "Invalid native child request ID");

export type NativeChildDiscovery = z.infer<typeof NativeChildDiscoverySchema>;

export const nativeChildDiscoverySignals = {
	nativeChildDiscovered: {
		payload: NativeChildDiscoverySchema,
	},
	nativeRootReady: {
		payload: z.object({ parentThreadId: z.string().min(1).max(512), durableSessionId: z.string().min(1).max(512), generation: z.number().int().positive() }).strict(),
	},
} as const;
