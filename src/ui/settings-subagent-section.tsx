import { type FC, useMemo } from "react";
import { experimental_ProviderModelPicker, type ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { useSubagentPolicy } from "./use-subagent-policy.ts";
import { useCatalogPreview } from "./use-catalog-preview.ts";
import { RoutingSelector } from "./routing-selector.tsx";
import {
	findDefaultCatalogProfile,
	isModelAvailableInCatalog,
	isThinkingSupportedInCatalog,
	pickerValueToProfile,
	profileToPickerValue,
} from "./profile-codec.ts";
import type { SubagentModelProfile } from "../policy/types.ts";

export const SubagentSettingsSection: FC = () => {
	const ProviderModelPicker = experimental_ProviderModelPicker;
	const {
		savedRecord,
		draftPolicy,
		isLoading,
		isSaving,
		error,
		isConflict,
		hasUnsavedChanges,
		setDraftPolicy,
		save,
		resetDraft,
	} = useSubagentPolicy();

	const {
		routing,
		setRouting,
		models,
		modelLoadError,
		isLoadingCatalog,
		catalogError,
		hosts,
		environments,
	} = useCatalogPreview();

	const currentMode = draftPolicy?.mode ?? "inherit";
	const effectiveProfile: SubagentModelProfile | null = useMemo(() => {
		if (draftPolicy?.configuredProfile) {
			return draftPolicy.configuredProfile;
		}
		if (savedRecord?.policy.configuredProfile) {
			return savedRecord.policy.configuredProfile;
		}
		return findDefaultCatalogProfile(models);
	}, [draftPolicy, savedRecord, models]);

	const isModelAvailable = useMemo(() => {
		if (!effectiveProfile || models.length === 0) return false;
		return (
			isModelAvailableInCatalog(effectiveProfile.model, models) &&
			isThinkingSupportedInCatalog(effectiveProfile.model, effectiveProfile.thinkingLevel, models)
		);
	}, [effectiveProfile, models]);

	const canSaveConfigured = currentMode === "configured" && isModelAvailable && !isLoadingCatalog && !catalogError && !modelLoadError;
	const canSave = (currentMode === "inherit" || canSaveConfigured) && hasUnsavedChanges && !isSaving && !isLoading;

	if (isLoading) {
		return <div className="p-4 text-sm text-muted-foreground">Loading subagent settings...</div>;
	}

	const pickerValue = effectiveProfile ? profileToPickerValue(effectiveProfile) : null;

	return (
		<div className="space-y-6 max-w-2xl text-sm">
			<div>
				<h3 className="text-base font-medium text-foreground">Subagent Model Policy</h3>
				<p className="text-muted-foreground mt-1">
					Settings apply globally to new subagent runs starting from the owner's next turn; running agents are not modified.
				</p>
			</div>

			<RoutingSelector
				routing={routing}
				setRouting={setRouting}
				hosts={hosts}
				environments={environments}
			/>

			<div className="space-y-3">
				<label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
					Model Selection Mode
				</label>
				<div className="space-y-2">
					<label className="flex items-center gap-2 cursor-pointer">
						<input
							type="radio"
							name="policy-mode"
							value="inherit"
							disabled={isSaving}
							checked={currentMode === "inherit"}
							onChange={() => setDraftPolicy((prev) => ({ mode: "inherit", configuredProfile: prev?.configuredProfile ?? effectiveProfile ?? undefined }))}
						/>
						<span>Inherit parent thread model</span>
					</label>
					<label className="flex items-center gap-2 cursor-pointer">
						<input
							type="radio"
							name="policy-mode"
							value="configured"
							disabled={isSaving}
							checked={currentMode === "configured"}
							onChange={() => { if (effectiveProfile) setDraftPolicy({ mode: "configured", configuredProfile: effectiveProfile }); }}
						/>
						<span>Use configured model</span>
					</label>
				</div>
			</div>

			<div className="space-y-2">
				<label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
					Subagent Model
				</label>
				{currentMode === "inherit" ? (
					<div className="p-3 bg-muted/40 border rounded text-muted-foreground text-xs">
						Subagents run with the same model and thinking level as the parent agent.
					</div>
				) : null}

				{isLoadingCatalog ? (
					<div className="text-xs text-muted-foreground">
						Loading catalog...
					</div>
				) : catalogError ? null : !routing ? (
					<div className="text-xs text-muted-foreground">
						No available hosts or environments to preview models.
					</div>
				) : pickerValue ? (
					<ProviderModelPicker
						value={pickerValue}
						disabled={currentMode === "inherit" || isSaving}
						allowProviderChange={false}
						routing={routing}
						onChange={(newVal: ExperimentalProviderModelPickerValue) => {
							try {
								const updatedProfile = pickerValueToProfile(newVal);
								setDraftPolicy({ mode: "configured", configuredProfile: updatedProfile });
							} catch {
								// ignore invalid picker state
							}
						}}
					/>
				) : (
					<div className="text-xs text-muted-foreground">
						Model catalog unavailable.
					</div>
				)}

				{currentMode === "configured" && !isModelAvailable && !isLoadingCatalog && effectiveProfile && (
					<div className="p-2 bg-amber-500/10 border border-amber-500/20 text-amber-600 rounded text-xs">
						Saved model ({effectiveProfile.model.provider}/{effectiveProfile.model.modelId}) is unavailable in the current context.
					</div>
				)}
			</div>

			{(error || catalogError || modelLoadError) && (
				<div className={`p-3 rounded border text-xs ${isConflict ? "bg-amber-500/10 border-amber-500/20 text-amber-700" : "bg-destructive/10 border-destructive/20 text-destructive"}`}>
					{error || catalogError || (modelLoadError ? `Catalog error: ${modelLoadError.code} ${modelLoadError.detail ?? ""}` : null)}
				</div>
			)}

			<div className="flex items-center gap-3 pt-2">
				<button
					type="button"
					className="px-4 py-1.5 bg-primary text-primary-foreground font-medium rounded text-xs disabled:opacity-50"
					disabled={!canSave}
					onClick={() => void save()}
				>
					{isSaving ? "Saving..." : "Save"}
				</button>
				<button
					type="button"
					className="px-3 py-1.5 border rounded text-xs disabled:opacity-50"
					disabled={!hasUnsavedChanges || isSaving}
					onClick={resetDraft}
				>
					Cancel
				</button>
			</div>
		</div>
	);
};
