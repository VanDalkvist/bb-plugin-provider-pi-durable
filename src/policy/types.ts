import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type SubagentPolicyMode = "inherit" | "configured";

export type SubagentThinkingLevel = ModelThinkingLevel;

export type SubagentModelReference = {
  provider: string;
  modelId: string;
};

export type SubagentModelProfile = {
  model: SubagentModelReference;
  thinkingLevel: SubagentThinkingLevel;
};

export type SubagentPolicy =
  | { mode: "inherit"; configuredProfile?: SubagentModelProfile }
  | { mode: "configured"; configuredProfile: SubagentModelProfile };

export type SubagentPolicyRecord = {
  version: 1;
  revision: number;
  updatedAt?: string;
  policy: SubagentPolicy;
};

export interface SubagentPolicyHolder {
  getRecord(): SubagentPolicyRecord;
  setRecord(record: SubagentPolicyRecord): void;
}

export type ResolvedChildConfiguration = {
  model: SubagentModelReference;
  thinkingLevel: SubagentThinkingLevel;
  source: "parent_inherited" | "user_configured";
  policyRevision: number;
};
