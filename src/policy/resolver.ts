import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type {
  ResolvedChildConfiguration,
  SubagentModelReference,
  SubagentPolicyRecord,
  SubagentThinkingLevel,
} from "./types.ts";
import {
  SubagentModelUnavailableError,
  SubagentPolicyInvalidError,
} from "./errors.ts";

export function mapBbReasoningToNativeThinking(
  level: string | undefined
): SubagentThinkingLevel {
  if (level === "none" || level === undefined) {
    return "off";
  }
  return level as SubagentThinkingLevel;
}

export function mapNativeThinkingToBbReasoning(
  level: SubagentThinkingLevel
): string {
  if (level === "off") {
    return "none";
  }
  return level;
}

export interface ResolveSubagentParentContext {
  model?: SubagentModelReference;
  thinkingLevel?: SubagentThinkingLevel | "none";
}

export function resolveSubagentModelConfiguration(
  record: SubagentPolicyRecord,
  parentContext: ResolveSubagentParentContext,
  availableModels: readonly Model<Api>[]
): ResolvedChildConfiguration {
  if (record.policy.mode === "inherit") {
    if (!parentContext.model?.provider || !parentContext.model?.modelId) {
      throw new SubagentPolicyInvalidError(
        "Parent model is required for inherit mode"
      );
    }
    return {
      model: {
        provider: parentContext.model.provider,
        modelId: parentContext.model.modelId,
      },
      thinkingLevel: mapBbReasoningToNativeThinking(parentContext.thinkingLevel),
      source: "parent_inherited",
      policyRevision: record.revision,
    };
  }

  const targetProfile = record.policy.configuredProfile;
  const foundModel = availableModels.find(
    (m) =>
      m.provider === targetProfile.model.provider &&
      m.id === targetProfile.model.modelId
  );

  if (!foundModel) {
    throw new SubagentModelUnavailableError(
      `Configured subagent model "${targetProfile.model.provider}/${targetProfile.model.modelId}" is unavailable or unauthenticated. Update the subagent model in Settings → Installed plugins → Pi Durable → Subagents.`
    );
  }

  const supportedLevels = getSupportedThinkingLevels(foundModel);
  if (!supportedLevels.includes(targetProfile.thinkingLevel)) {
    throw new SubagentPolicyInvalidError(
      `Thinking level "${targetProfile.thinkingLevel}" is not supported by model "${targetProfile.model.provider}/${targetProfile.model.modelId}". Supported levels: ${supportedLevels.join(", ")}.`
    );
  }

  return {
    model: {
      provider: targetProfile.model.provider,
      modelId: targetProfile.model.modelId,
    },
    thinkingLevel: targetProfile.thinkingLevel,
    source: "user_configured",
    policyRevision: record.revision,
  };
}
