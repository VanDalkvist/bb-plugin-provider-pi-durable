export interface ReasoningTranslationState {
 currentThinkingIndex: number;
 openThinkingChannels?: Set<string>;
}
export interface MessageTranslationState extends ReasoningTranslationState {
 currentAgentText: string;
}
