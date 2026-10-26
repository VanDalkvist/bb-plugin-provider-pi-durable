import { defineDoc, type ConversationId, type JsonObject } from "@earendil-works/pi-durable";

export interface StoredBinding {
	readonly providerId: string;
	readonly sessionId: string;
	readonly conversationId: ConversationId;
	readonly bbThreadId: string;
	readonly parentThreadId: string | null;
	readonly createdAt: number;
}

export type BindingState = JsonObject & {
	binding: StoredBinding | null;
};

export type BindingIndex = JsonObject & {
	byIdentity: Record<string, ConversationId>;
	byThreadId: Record<string, ConversationId>;
};

export const BindingDoc = defineDoc<BindingState>({
	kind: "bb.native-child-binding",
	version: 2,
	scope: "conversation",
	checkpointWhen: () => false,
	history: "latest",
	fork: "initial",
	initial: () => ({ binding: null }),
});

export const BindingIndexDoc = defineDoc<BindingIndex>({
	kind: "bb.native-child-binding-index",
	version: 1,
	scope: "session",
	checkpointWhen: () => false,
	initial: () => ({ byIdentity: {}, byThreadId: {} }),
});

export function identityKey(identity: { providerId: string; sessionId: string; bbThreadId: string }): string {
	return JSON.stringify([identity.providerId, identity.sessionId, identity.bbThreadId]);
}
