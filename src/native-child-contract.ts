import { z } from "zod";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";

const identityText = z.string().min(1).max(512);
const durableNumber = z.number().int().safe().nonnegative();
const taskId = durableNumber.transform((value) => value as TaskId);
const conversationId = durableNumber.transform((value) => value as ConversationId);

export const NativePlacementSchema = z.object({
	parentThreadId: identityText,
	projectId: identityText,
	environmentId: identityText,
	hostId: identityText,
	providerId: z.literal("pi-durable"),
}).strict();

export type NativePlacement = z.infer<typeof NativePlacementSchema>;

export const OrdinaryRootPlacementSchema = z.object({
	parentThreadId: identityText.nullable(),
	projectId: identityText,
	environmentId: identityText,
	hostId: identityText,
	providerId: z.literal("pi-durable"),
}).strict();

export type OrdinaryRootPlacement = z.infer<typeof OrdinaryRootPlacementSchema>;

export type DurableChildIdentity = {
	durableSessionId: string;
	taskId: TaskId;
	conversationId: ConversationId;
	requestId: string;
};

export type OrdinaryRootRoute = {
	kind: "ordinary-root";
	threadId: string;
	providerThreadId: string;
	placement: OrdinaryRootPlacement;
};

export type NativeChildRoute = {
	kind: "native-child";
	threadId: string;
	providerThreadId: string;
	placement: NativePlacement;
	child: DurableChildIdentity;
	bootstrapRequestId: string;
};

export const OrdinaryRootRouteSchema = z.object({
	kind: z.literal("ordinary-root"),
	threadId: identityText,
	providerThreadId: identityText,
	placement: OrdinaryRootPlacementSchema,
}).strict();

export const NativeChildRouteSchema = z.object({
	kind: z.literal("native-child"),
	threadId: identityText,
	providerThreadId: identityText,
	placement: NativePlacementSchema,
	child: z.object({
		durableSessionId: identityText,
		taskId,
		conversationId,
		requestId: identityText,
	}).strict(),
	bootstrapRequestId: identityText,
}).strict();

export type RegisteredRoute = OrdinaryRootRoute | NativeChildRoute;

const expectedPlacementSchema = NativePlacementSchema;

export const RedemptionIdentitySchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("ordinary-root"),
		threadId: identityText,
		providerThreadId: identityText,
		placement: OrdinaryRootPlacementSchema,
	}).strict(),
	z.object({
		kind: z.literal("native-child"),
		threadId: identityText,
		providerThreadId: identityText,
		placement: expectedPlacementSchema,
		child: z.object({
			durableSessionId: identityText,
			taskId,
			conversationId,
			requestId: identityText,
		}).strict(),
		bootstrapRequestId: identityText,
	}).strict(),
]);

export type RedemptionIdentity = z.infer<typeof RedemptionIdentitySchema>;

export const BootstrapControlSchema = z.object({
	type: z.literal("native-child-bootstrap"),
	requestId: identityText,
}).strict();

export type BootstrapControl = z.infer<typeof BootstrapControlSchema>;

export const NativeChildViewCommandSchema = z.object({
	type: z.enum(["native-child-view-attach", "native-child-view-detach"]),
	durableSessionId: identityText,
	parentConversationId: conversationId,
	childConversationId: conversationId,
	taskId,
	viewId: z.string().min(1).max(128),
	id: z.string().min(1).max(128).optional(),
}).strict();

export const NativeChildViewEventSchema = z.object({
	type: z.literal("native-child-view-event"),
	viewId: z.string().min(1).max(128),
	durableSessionId: identityText,
	taskId: durableNumber,
	childConversationId: durableNumber,
	event: z.object({ type: z.string().min(1) }).catchall(z.unknown()),
}).strict();

export function routeKey(identity: Pick<RegisteredRoute, "threadId" | "providerThreadId">): string {
	return JSON.stringify([identity.threadId, identity.providerThreadId]);
}
