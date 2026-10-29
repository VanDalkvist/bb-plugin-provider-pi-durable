import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { piDiagnosticsReportSchema } from "../contracts/diagnostics.ts";
import {
  subagentPolicyRecordSchema,
  subagentPolicySetInputSchema,
} from "../policy/schema.ts";

export const rpcContract = defineRpcContract({
  diagnostics_get: {
    input: z.object({}).optional(),
    output: z.object({
      report: piDiagnosticsReportSchema,
    }),
  },
  subagent_policy_get: {
    input: z.object({}).optional(),
    output: z.object({
      record: subagentPolicyRecordSchema,
    }),
  },
  subagent_policy_set: {
    input: subagentPolicySetInputSchema,
    output: z.object({
      record: subagentPolicyRecordSchema,
    }),
  },
  task_abort: {
    input: z.object({
      threadId: z.string(),
      taskId: z.number().int().positive(),
    }),
    output: z.object({
      ok: z.boolean(),
    }),
  },
});

export type PiRpcContract = typeof rpcContract;
