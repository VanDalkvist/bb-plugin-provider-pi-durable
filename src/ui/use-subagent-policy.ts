import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server.ts";
import type { SubagentPolicy, SubagentPolicyRecord } from "../policy/types.ts";

export interface UseSubagentPolicyResult {
	savedRecord: SubagentPolicyRecord | null;
	draftPolicy: SubagentPolicy | null;
	isLoading: boolean;
	isSaving: boolean;
	error: string | null;
	isConflict: boolean;
	hasUnsavedChanges: boolean;
	setDraftPolicy: (policy: SubagentPolicy | ((prev: SubagentPolicy | null) => SubagentPolicy | null)) => void;
	save: () => Promise<boolean>;
	resetDraft: () => void;
	refetch: () => Promise<void>;
}

export function useSubagentPolicy(): UseSubagentPolicyResult {
	const rpc = useRpc<typeof rpcContract>();
	const [savedRecord, setSavedRecord] = useState<SubagentPolicyRecord | null>(null);
	const [draftPolicy, setDraftPolicy] = useState<SubagentPolicy | null>(null);
	const [isLoading, setIsLoading] = useState<boolean>(true);
	const [isSaving, setIsSaving] = useState<boolean>(false);
	const [error, setError] = useState<string | null>(null);
	const [isConflict, setIsConflict] = useState<boolean>(false);

	const fetchPolicy = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const res = await rpc.call("subagent_policy_get", {});
			setSavedRecord(res.record);
			setDraftPolicy((prev) => prev ?? res.record.policy);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsLoading(false);
		}
	}, [rpc]);

	useEffect(() => {
		void fetchPolicy();
	}, [fetchPolicy]);

	const save = useCallback(async (): Promise<boolean> => {
		if (!draftPolicy || !savedRecord) return false;
		const snapshotToSave = draftPolicy;
		setIsSaving(true);
		setError(null);
		setIsConflict(false);
		try {
			const res = await rpc.call("subagent_policy_set", {
				policy: snapshotToSave,
				expectedRevision: savedRecord.revision,
			});
			setSavedRecord(res.record);
			setDraftPolicy((currentDraft) => {
				if (currentDraft && JSON.stringify(currentDraft) === JSON.stringify(snapshotToSave)) {
					return res.record.policy;
				}
				return currentDraft;
			});
			return true;
		} catch (err: unknown) {
			const code = (err as { code?: string })?.code;
			const msg = err instanceof Error ? err.message : String(err);
			if (code === "conflict" || msg.toLowerCase().includes("conflict")) {
				setIsConflict(true);
				setError("Conflict: settings were updated in another session. Your draft is preserved — click \"Save\" again to apply.");
				try {
					const latest = await rpc.call("subagent_policy_get", {});
					setSavedRecord(latest.record);
				} catch {
					// retain current savedRecord if refetch fails
				}
			} else {
				setError(`Save failed: ${msg}`);
			}
			return false;
		} finally {
			setIsSaving(false);
		}
	}, [draftPolicy, savedRecord, rpc]);

	const resetDraft = useCallback(() => {
		if (savedRecord) {
			setDraftPolicy(savedRecord.policy);
			setError(null);
			setIsConflict(false);
		}
	}, [savedRecord]);

	const hasUnsavedChanges = Boolean(
		savedRecord && draftPolicy && JSON.stringify(savedRecord.policy) !== JSON.stringify(draftPolicy),
	);

	return {
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
		refetch: fetchPolicy,
	};
}
