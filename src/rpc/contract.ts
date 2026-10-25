import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { PiDiagnosticsReport } from "../runner/diagnostics-types.ts";
import {
  subagentPolicyRecordSchema,
  subagentPolicySetInputSchema,
} from "../policy/schema.ts";

export const rpcContract = defineRpcContract({
  diagnostics_get: {
    input: z.object({}).optional(),
    output: z.object({
      report: z.custom<PiDiagnosticsReport>(),
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
});

export type PiRpcContract = typeof rpcContract;
