import { DurableBindingManager } from "./durable-binding-store.ts";
import { resolveSessionFilePath } from "./paths.ts";

export interface NativeChildResolution {
	isNative: boolean;
	conversationId?: string;
}

export function detectNativeChild(
	threadId: string,
	conversationIdFromProviderThreadId?: string,
	paramConversationId?: string,
	parentSessionFilePath?: string,
): NativeChildResolution {
	if (conversationIdFromProviderThreadId) {
		return { isNative: true, conversationId: conversationIdFromProviderThreadId };
	}
	if (paramConversationId) {
		return { isNative: true, conversationId: paramConversationId };
	}
	if (parentSessionFilePath) {
		try {
			const offline = DurableBindingManager.prototype.readOfflineBindings(parentSessionFilePath);
			const match = offline.find((item) => item.bbThreadId === threadId);
			if (match) {
				return { isNative: true, conversationId: match.conversationId };
			}
		} catch {
			// Ignore offline read failure
		}
	}
	return { isNative: false };
}
