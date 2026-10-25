import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { DurableBindingManager } from "./durable-binding-store.ts";
import { resolveSessionFilePath } from "./paths.ts";

export interface NativeChildResolution {
	isNative: boolean;
	conversationId?: string;
}

const ROOT_CONVERSATION_ID_STR = String(ROOT_CONVERSATION_ID);

export function detectNativeChild(
	threadId: string,
	conversationIdFromProviderThreadId?: string,
	paramConversationId?: string,
	parentSessionFilePath?: string,
): NativeChildResolution {
	if (conversationIdFromProviderThreadId && conversationIdFromProviderThreadId !== ROOT_CONVERSATION_ID_STR) {
		return { isNative: true, conversationId: conversationIdFromProviderThreadId };
	}
	if (paramConversationId && paramConversationId !== ROOT_CONVERSATION_ID_STR) {
		return { isNative: true, conversationId: paramConversationId };
	}
	if (parentSessionFilePath) {
		try {
			const offline = DurableBindingManager.prototype.readOfflineBindings(parentSessionFilePath);
			const match = offline.find((item) => item.bbThreadId === threadId);
			if (match && match.conversationId !== ROOT_CONVERSATION_ID_STR) {
				return { isNative: true, conversationId: match.conversationId };
			}
		} catch {
			// Ignore offline read failure
		}
	}
	return { isNative: false };
}
