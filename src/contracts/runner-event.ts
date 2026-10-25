import { z } from "zod";
import { messageSchemas } from "./wire-message.ts";
import { toolSchemas } from "./wire-tool.ts";
import { lifecycleSchemas } from "./wire-lifecycle.ts";

export const runnerEventSchema = z.discriminatedUnion("type", [...messageSchemas, ...toolSchemas, ...lifecycleSchemas]);
export type RunnerEvent = z.infer<typeof runnerEventSchema>;
export type BBWireEvent = RunnerEvent;
export const knownEventTypes : ReadonlySet<string> = new Set(runnerEventSchema.options.map((schema) => schema.shape.type.value));
export type BBAgentStartEvent = Extract<RunnerEvent, { type: "agent_start" }>;
export type BBTurnStartEvent = Extract<RunnerEvent, { type: "turn_start" }>;
export type BBTurnEndEvent = Extract<RunnerEvent, { type: "turn_end" }>;
export type BBMessageEndEvent = Extract<RunnerEvent, { type: "message_end" }>;
export type BBAgentEndEvent = Extract<RunnerEvent, { type: "agent_end" }>;
