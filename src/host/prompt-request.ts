import type { PiPromptImage } from "./prompt-input.ts";

export interface PromptRequest {
 text: string;
 images?: PiPromptImage[];
 conversationId?: string;
}
