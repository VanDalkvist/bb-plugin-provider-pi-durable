export interface CommandResponder {
	success: (id: string | undefined, command: string, data?: unknown) => void;
	error: (id: string | undefined, command: string, message: string) => void;
}

export interface RunnerCommandPayload {
	type?: string;
	id?: string;
	message?: string;
	images?: import("@earendil-works/pi-ai").ImageContent[];
	streamingBehavior?: string;
	provider?: string;
	modelId?: string;
	instructions?: string;
	level?: import("@earendil-works/pi-ai").ModelThinkingLevel;
	conversationId?: string | number;
	bbThreadId?: string;
	parentThreadId?: string;
	sessionId?: string;
	policyRecord?: unknown;
}
