import type { SessionOptions } from "./types.ts";
import type { PromptRequest } from "./prompt-request.ts";
import type { SubagentMirrorRecord } from "./subagent-mirror.ts";
import type { SubagentPolicyRecord } from "../policy/types.ts";

export interface SessionCreationParams {
	cwd?: string;
	parentThreadId?: string;
	conversationId?: string;
	input?: unknown;
	prompt?: string;
	task?: string;
	model?: unknown;
	thinkingLevel?: unknown;
	shellEnvOverrides?: NodeJS.ProcessEnv;
	providerOptions?: Record<string, unknown>;
	options?: {
		cwd?: string;
		parentThreadId?: string;
		model?: unknown;
		reasoningLevel?: unknown;
		thinkingLevel?: unknown;
		envVars?: NodeJS.ProcessEnv;
		providerOptions?: Record<string, unknown>;
		instructions?: string;
		[key: string]: unknown;
	};
	baseInstructions?: string;
	instructionMode?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	[key: string]: unknown;
}

export interface SessionRunnerPort {
 exited: boolean;
 requestOk(command: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}
export interface SessionPort {
 options: SessionOptions;
 runner: SessionRunnerPort;
 prompt(request: PromptRequest): Promise<void>;
 steer(request: PromptRequest): Promise<void>;
 abort(conversationId?: string): Promise<void>;
 compact(instructions?: string): Promise<void>;
 refreshContextUsage(): Promise<void>;
 getLastCheckpointId(): string | null;
 registerThread(threadId: string, conversationId?: string): boolean;
 getConversationIdForThread(threadId: string): string | undefined;
 getSubagentState(id: string | number): SubagentMirrorRecord | undefined;
 findSubagentConversationForTask(task: string): string | undefined;
 getMirrorOutputText(id: string | number): string;
 markInitialMirrorTurnConsumed(id: string | number): void;
 consumeCompletedMirror(id: string | number): void;
 setModel(provider: string, modelId: string): Promise<void>;
 setThinkingLevel(level: string): Promise<void>;
 setSubagentPolicy(record: SubagentPolicyRecord): Promise<void>;
 getAcknowledgedSubagentPolicyRevision(): number | undefined;
}
export interface OwnedSessionPort extends SessionPort {
 start(): Promise<void>;
 closeGracefully(): Promise<void>;
 kill(): void;
 unregisterThread(threadId: string): void;
}
export interface SessionRegistryPort {
 get(threadId: string): OwnedSessionPort | undefined;
 getBoundProviderThreadId?(threadId: string): string | undefined;
 createOrGet(threadId: string, providerThreadId: string, params?: SessionCreationParams): Promise<OwnedSessionPort>;
 reconcileCwd(threadId: string, cwd?: string): Promise<OwnedSessionPort | undefined>;
 stop(threadId: string): Promise<void>;
}
