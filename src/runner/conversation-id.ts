import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";

export function parseConversationId(id: string | number | undefined | null): import("@earendil-works/pi-durable").ConversationId {
	if (id === undefined || id === null) return ROOT_CONVERSATION_ID;
	const trimmed = typeof id === "string" ? id.trim() : id;
	if (trimmed === "") {
		throw new Error(`Invalid conversationId: ${String(id)}`);
	}
	const num = typeof trimmed === "number" ? trimmed : Number(trimmed);
	if (!Number.isInteger(num) || num <= 0) {
		throw new Error(`Invalid conversationId: ${String(id)}`);
	}
	return num as import("@earendil-works/pi-durable").ConversationId;
}
