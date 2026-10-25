import { useCallback, useEffect, useRef, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { CatalogModelDescriptorLike } from "./profile-codec.ts";

export type PreviewRouting =
	| { kind: "host"; hostId: string }
	| { kind: "environment"; environmentId: string };

export interface UseCatalogPreviewResult {
	routing: PreviewRouting | null;
	setRouting: (routing: PreviewRouting) => void;
	models: readonly CatalogModelDescriptorLike[];
	modelLoadError: { code: string; detail: string | null } | null;
	isLoadingCatalog: boolean;
	catalogError: string | null;
	hosts: readonly { id: string; name?: string }[];
	environments: readonly { id: string; name?: string }[];
}

export function useCatalogPreview(): UseCatalogPreviewResult {
	const sdk = useSdk();
	const [hosts, setHosts] = useState<readonly { id: string; name?: string }[]>([]);
	const [environments, setEnvironments] = useState<readonly { id: string; name?: string }[]>([]);
	const [routing, setRouting] = useState<PreviewRouting | null>(null);
	const [models, setModels] = useState<readonly CatalogModelDescriptorLike[]>([]);
	const [modelLoadError, setModelLoadError] = useState<{ code: string; detail: string | null } | null>(null);
	const [isLoadingCatalog, setIsLoadingCatalog] = useState<boolean>(true);
	const [catalogError, setCatalogError] = useState<string | null>(null);

	const activeAbortRef = useRef<AbortController | null>(null);
	const isMountedRef = useRef<boolean>(true);
	const queryVersionRef = useRef(0);

	// Load routing targets once at boot using direct SDK 0.6.79 contracts without fake defaults
	useEffect(() => {
		let active = true;
		async function initRouting() {
			try {
				const [cfg, hList, eList] = await Promise.all([
					sdk.system.config(),
					sdk.hosts.list(),
					sdk.environments.list(),
				]);
				if (!active) return;
				setHosts(hList as { id: string; name?: string }[]);
				setEnvironments(eList as { id: string; name?: string }[]);

				let initial: PreviewRouting | null = null;
				if (cfg?.primaryHostId && typeof cfg.primaryHostId === "string" && cfg.primaryHostId.trim() !== "") {
					initial = { kind: "host", hostId: cfg.primaryHostId };
				} else if (Array.isArray(hList) && hList.length > 0 && hList[0]?.id) {
					initial = { kind: "host", hostId: hList[0].id };
				} else if (Array.isArray(eList) && eList.length > 0 && eList[0]?.id) {
					initial = { kind: "environment", environmentId: eList[0].id };
				}
				setRouting(initial);
				if (!initial) {
					setIsLoadingCatalog(false);
				}
			} catch (err) {
				console.error("[initRouting error]", err);
				if (!active) return;
				setRouting(null);
				setIsLoadingCatalog(false);
				setCatalogError(err instanceof Error ? err.message : String(err));
			}
		}
		void initRouting();
		return () => {
			active = false;
		};
	}, [sdk]);

	const loadModels = useCallback(async (currentRouting: PreviewRouting, controller: AbortController) => {
		const currentVersion = ++queryVersionRef.current;
		setIsLoadingCatalog(true);
		setCatalogError(null);
		setModels([]);
		setModelLoadError(null);

		try {
			const queryArgs =
				currentRouting.kind === "host"
					? { providerId: "pi-durable", hostId: currentRouting.hostId, signal: controller.signal }
					: { providerId: "pi-durable", environmentId: currentRouting.environmentId, signal: controller.signal };

			const res = await sdk.providers.models(queryArgs);
			if (!isMountedRef.current || queryVersionRef.current !== currentVersion || controller.signal.aborted) {
				return;
			}

			setModels((res?.models as CatalogModelDescriptorLike[]) ?? []);
			setModelLoadError(res?.modelLoadError ?? null);
		} catch (err: unknown) {
			if (!isMountedRef.current || queryVersionRef.current !== currentVersion || controller.signal.aborted) {
				return;
			}
			if ((err as Error)?.name === "AbortError") return;
			setCatalogError(err instanceof Error ? err.message : String(err));
			setModels([]);
			setModelLoadError(null);
		} finally {
			if (isMountedRef.current && queryVersionRef.current === currentVersion && !controller.signal.aborted) {
				setIsLoadingCatalog(false);
			}
		}
	}, [sdk]);

	useEffect(() => {
		isMountedRef.current = true;
		if (!routing) {
			setModels([]);
			setModelLoadError(null);
			setIsLoadingCatalog(false);
			return;
		}

		activeAbortRef.current?.abort();
		const controller = new AbortController();
		activeAbortRef.current = controller;
		void loadModels(routing, controller);

		return () => {
			controller.abort();
		};
	}, [routing, loadModels]);

	useEffect(() => {
		return () => {
			isMountedRef.current = false;
			activeAbortRef.current?.abort();
		};
	}, []);

	return {
		routing,
		setRouting,
		models,
		modelLoadError,
		isLoadingCatalog,
		catalogError,
		hosts,
		environments,
	};
}
