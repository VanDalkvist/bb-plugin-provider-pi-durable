import type { FC } from "react";
import type { PreviewRouting } from "./use-catalog-preview.ts";

export interface RoutingSelectorProps {
	routing: PreviewRouting | null;
	setRouting: (routing: PreviewRouting) => void;
	hosts: readonly { id: string; name?: string }[];
	environments: readonly { id: string; name?: string }[];
}

export const RoutingSelector: FC<RoutingSelectorProps> = ({
	routing,
	setRouting,
	hosts,
	environments,
}) => {
	if (hosts.length === 0 && environments.length === 0) return null;

	return (
		<div className="space-y-2">
			<label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
				Контекст предпросмотра
			</label>
			<div className="flex gap-2 items-center">
				{hosts.length > 0 && (
					<select
						aria-label="Выбор хоста для предпросмотра"
						className="border rounded px-2 py-1 bg-background text-foreground text-xs"
						value={routing?.kind === "host" ? routing.hostId : ""}
						onChange={(e) => setRouting({ kind: "host", hostId: e.target.value })}
					>
						{hosts.map((h) => (
							<option key={h.id} value={h.id}>
								Хост: {h.name || h.id}
							</option>
						))}
					</select>
				)}
				{environments.length > 0 && (
					<select
						aria-label="Выбор окружения для предпросмотра"
						className="border rounded px-2 py-1 bg-background text-foreground text-xs"
						value={routing?.kind === "environment" ? routing.environmentId : ""}
						onChange={(e) => setRouting({ kind: "environment", environmentId: e.target.value })}
					>
						<option value="" disabled>Выберите окружение</option>
						{environments.map((env) => (
							<option key={env.id} value={env.id}>
								Окружение: {env.name || env.id}
							</option>
						))}
					</select>
				)}
			</div>
		</div>
	);
};
