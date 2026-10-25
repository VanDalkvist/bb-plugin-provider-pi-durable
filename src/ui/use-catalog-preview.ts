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

	// Load routing targets once at boot
	useEffect(() => {
		let active = true;
		async function initRouting() {
			try {
				const [cfg, hList, eList] = await Promise.all([
					sdk.system?.config ? sdk.system.config() : Promise.resolve({ primaryHostId: "default" }),
					sdk.hosts?.list ? sdk.hosts.list() : Promise.resolve([]),
					sdk.environments?.list ? sdk.environments.list() : Promise.resolve([]),
				]);
				if (!active) return;
				setHosts(hList as { id: string; name?: string }[]);
				setEnvironments(eList as { id: string; name?: string }[]);

				const initialHostId = cfg?.primaryHostId ?? (hList[0]?.id || "default");
				setRouting((prev) => prev ?? { kind: "host", hostId: initialHostId });
			} catch (err) {
				if (!active) return;
				setRouting((prev) => prev ?? { kind: "host", hostId: "default" });
			}
		}
		void initRouting();
		return () => {
			active = false;
		};
	}, [sdk]);

	const queryVersionRef = useRef(0);

	const loadModels = useCallback(async (currentRouting: PreviewRouting) => {
		const currentVersion = ++queryVersionRef.current;
		setIsLoadingCatalog(true);
		setCatalogError(null);
		const controller = new AbortController();

		try {
			const queryArgs =
				currentRouting.kind === "host"
					? { providerId: "pi-durable", hostId: currentRouting.hostId, signal: controller.signal }
					: { providerId: "pi-durable", environmentId: currentRouting.environmentId, signal: controller.signal };

			const res = await sdk.providers.models(queryArgs);
			if (queryVersionRef.current !== currentVersion) return;

			setModels((res?.models as CatalogModelDescriptorLike[]) ?? []);
			setModelLoadError(res?.modelLoadError ?? null);
		} catch (err: unknown) {
			if (queryVersionRef.current !== currentVersion) return;
			if ((err as Error)?.name === "AbortError") return;
			setCatalogError(err instanceof Error ? err.message : String(err));
			setModels([]);
			setModelLoadError(null);
		} finally {
			if (queryVersionRef.current === currentVersion) {
				setIsLoadingCatalog(false);
			}
		}
	}, [sdk]);

	useEffect(() => {
		if (routing) {
			void loadModels(routing);
		}
	}, [routing, loadModels]);

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
