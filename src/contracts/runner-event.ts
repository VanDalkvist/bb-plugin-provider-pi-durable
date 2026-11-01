import { z } from "zod";
import { messageSchemas } from "./wire-message.ts";
import { toolSchemas } from "./wire-tool.ts";
import { lifecycleSchemas } from "./wire-lifecycle.ts";

export const runnerEventSchema = z.discriminatedUnion("type", [...messageSchemas, ...toolSchemas, ...lifecycleSchemas]);
export type RunnerEvent = z.infer<typeof runnerEventSchema>;
export const knownEventTypes: ReadonlySet<string> = new Set(runnerEventSchema.options.map((schema) => schema.shape.type.value));
export type AgentStartEvent = Extract<RunnerEvent, { type: "agent_start" }>;
export type TurnStartEvent = Extract<RunnerEvent, { type: "turn_start" }>;
export type TurnEndEvent = Extract<RunnerEvent, { type: "turn_end" }>;
export type MessageEndEvent = Extract<RunnerEvent, { type: "message_end" }>;
export type AgentEndEvent = Extract<RunnerEvent, { type: "agent_end" }>;
