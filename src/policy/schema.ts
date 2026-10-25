import { z } from "zod";
import type {
  SubagentModelProfile,
  SubagentModelReference,
  SubagentPolicy,
  SubagentPolicyRecord,
  SubagentThinkingLevel,
} from "./types.ts";

export const SUBAGENT_POLICY_KV_KEY = "subagent.policy.v1" as const;

export const subagentThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]) satisfies z.ZodType<SubagentThinkingLevel>;

export const subagentModelReferenceSchema = z
  .object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
  })
  .strict() satisfies z.ZodType<SubagentModelReference>;

export const subagentModelProfileSchema = z
  .object({
    model: subagentModelReferenceSchema,
    thinkingLevel: subagentThinkingLevelSchema,
  })
  .strict() satisfies z.ZodType<SubagentModelProfile>;

export const subagentPolicySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("inherit"),
      configuredProfile: subagentModelProfileSchema.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("configured"),
      configuredProfile: subagentModelProfileSchema,
    })
    .strict(),
]) satisfies z.ZodType<SubagentPolicy>;

export const subagentPolicyRecordSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().optional(),
    policy: subagentPolicySchema,
  })
  .strict() satisfies z.ZodType<SubagentPolicyRecord>;

export const subagentPolicySetInputSchema = z
  .object({
    policy: subagentPolicySchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export const subagentPolicyGetOutputSchema = z
  .object({
    record: subagentPolicyRecordSchema,
  })
  .strict();

export const subagentPolicySetOutputSchema = z
  .object({
    record: subagentPolicyRecordSchema,
  })
  .strict();
