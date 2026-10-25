import type {
	SubagentModelProfile,
	SubagentModelReference,
	SubagentThinkingLevel,
} from "../policy/types.ts";
import {
	subagentModelProfileSchema,
	subagentThinkingLevelSchema,
} from "../policy/schema.ts";

export interface ModelPickerValueLike {
	providerId: string;
	model: string;
	reasoningLevel: string;
}

export interface CatalogModelDescriptorLike {
	id: string;
	model: string;
	displayName?: string;
	isDefault?: boolean;
	defaultReasoningEffort?: string;
	supportedReasoningEfforts?: readonly {
		reasoningEffort: string;
		label?: string;
		description?: string;
	}[];
}

export function profileToPickerValue(
	profile: SubagentModelProfile,
): ModelPickerValueLike {
	const modelString = `${profile.model.provider}/${profile.model.modelId}`;
	const reasoningLevel = profile.thinkingLevel === "off" ? "none" : profile.thinkingLevel;
	return {
		providerId: "pi-durable",
		model: modelString,
		reasoningLevel,
	};
}

export function pickerValueToProfile(
	val: ModelPickerValueLike,
): SubagentModelProfile {
	if (val.providerId !== "pi-durable") {
		throw new Error(`Invalid providerId: expected 'pi-durable', got '${val.providerId}'`);
	}
	const slash = val.model.indexOf("/");
	if (slash === -1) {
		throw new Error(`Invalid model format: expected 'provider/modelId', got '${val.model}'`);
	}
	const provider = val.model.slice(0, slash);
	const modelId = val.model.slice(slash + 1);

	const thinkingLevel: SubagentThinkingLevel =
		val.reasoningLevel === "none" ? "off" : (val.reasoningLevel as SubagentThinkingLevel);

	subagentThinkingLevelSchema.parse(thinkingLevel);

	const profile: SubagentModelProfile = {
		model: { provider, modelId },
		thinkingLevel,
	};
	return subagentModelProfileSchema.parse(profile);
}

export function isModelAvailableInCatalog(
	modelRef: SubagentModelReference,
	catalogModels: readonly CatalogModelDescriptorLike[],
): boolean {
	const targetId = `${modelRef.provider}/${modelRef.modelId}`;
	return catalogModels.some((m) => m.id === targetId || m.model === targetId);
}

export function isThinkingSupportedInCatalog(
	modelRef: SubagentModelReference,
	thinkingLevel: SubagentThinkingLevel,
	catalogModels: readonly CatalogModelDescriptorLike[],
): boolean {
	const targetId = `${modelRef.provider}/${modelRef.modelId}`;
	const found = catalogModels.find((m) => m.id === targetId || m.model === targetId);
	if (!found) return false;
	const efforts = found.supportedReasoningEfforts ?? [];
	if (efforts.length === 0) {
		return thinkingLevel === "off";
	}
	const bbLevel = thinkingLevel === "off" ? "none" : thinkingLevel;
	return efforts.some((e) => e.reasoningEffort === bbLevel);
}

export function findDefaultCatalogProfile(
	catalogModels: readonly CatalogModelDescriptorLike[],
): SubagentModelProfile | null {
	if (catalogModels.length === 0) return null;
	const defaultModel = catalogModels.find((m) => m.isDefault) ?? catalogModels[0];
	const slash = defaultModel.model.indexOf("/");
	if (slash === -1) return null;

	const provider = defaultModel.model.slice(0, slash);
	const modelId = defaultModel.model.slice(slash + 1);
	const bbReasoning = defaultModel.defaultReasoningEffort ?? "none";
	const thinkingLevel: SubagentThinkingLevel = bbReasoning === "none" ? "off" : (bbReasoning as SubagentThinkingLevel);

	return {
		model: { provider, modelId },
		thinkingLevel,
	};
}
