import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { normalizeModelReference } from "../shared/model-ref.ts";
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
    const parentModel = normalizeModelReference(parentContext.model);
    if (!parentModel) {
      throw new SubagentPolicyInvalidError(
        "Parent model is required for inherit mode"
      );
    }
    return {
      model: {
        provider: parentModel.provider,
        modelId: parentModel.modelId,
      },
      thinkingLevel: mapBbReasoningToNativeThinking(parentContext.thinkingLevel),
      source: "parent_inherited",
      policyRevision: record.revision,
    };
  }

  const targetProfile = record.policy.configuredProfile;
  const targetModel = normalizeModelReference(targetProfile.model);
  const foundModel = targetModel
    ? availableModels.find((m) => {
        const availableNorm = normalizeModelReference(m, m.provider);
        return (
          availableNorm &&
          availableNorm.provider === targetModel.provider &&
          availableNorm.modelId === targetModel.modelId
        );
      })
    : undefined;

  if (!foundModel || !targetModel) {
    throw new SubagentModelUnavailableError(
      `Configured subagent model "${targetProfile.model.provider}/${targetProfile.model.modelId}" is unavailable or unauthenticated. Update the subagent model in Settings → Installed plugins → Pi Durable → Subagents.`
    );
  }

  const supportedLevels = getSupportedThinkingLevels(foundModel);
  if (!supportedLevels.includes(targetProfile.thinkingLevel)) {
    throw new SubagentPolicyInvalidError(
      `Thinking level "${targetProfile.thinkingLevel}" is not supported by model "${targetModel.provider}/${targetModel.modelId}". Supported levels: ${supportedLevels.join(", ")}.`
    );
  }

  return {
    model: {
      provider: targetModel.provider,
      modelId: targetModel.modelId,
    },
    thinkingLevel: targetProfile.thinkingLevel,
    source: "user_configured",
    policyRevision: record.revision,
  };
}
