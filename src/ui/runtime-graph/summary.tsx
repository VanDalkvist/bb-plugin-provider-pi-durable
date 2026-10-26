import React, { type FC, useMemo } from "react";
import { experimental_Icon } from "@get-bb/plugin-sdk/app";
import type { RuntimeGraphState } from "./types.ts";
import { useRuntimeGraphState } from "./use-runtime-graph-state.ts";

export interface RuntimeGraphSummaryProps {
	readonly threadId: string;
	readonly projectId: string;
	readonly environment: unknown | null;
	readonly segments: readonly unknown[];
	readonly isExpanded: boolean;
	readonly onToggle: () => void;
	readonly testState?: RuntimeGraphState;
}

export const RuntimeGraphSummary: FC<RuntimeGraphSummaryProps> = ({
	threadId,
	isExpanded,
	onToggle,
	testState,
}) => {
	const Icon = experimental_Icon;
	const liveState = useRuntimeGraphState(undefined, threadId);
	const state = testState ?? liveState;

	const { snapshot, status } = state;

	const counters = useMemo(() => {
		if (!snapshot) return null;
		let running = 0;
		let waiting = 0;
		let sleeping = 0;
		let completing = 0;

		for (const node of Object.values(snapshot.nodes)) {
			switch (node.state.status) {
				case "running":
					running++;
					break;
				case "waiting":
					waiting++;
					break;
				case "sleeping":
					sleeping++;
					break;
				case "completing":
					completing++;
					break;
			}
		}

		const active = running + waiting + sleeping + completing;
		const hasToolError = snapshot.receipts.some((r) => r.isToolError);
		const terminalCount = snapshot.receipts.length;
		const isLimited = snapshot.observation.completeness === "limited";

		return { active, running, waiting, sleeping, completing, hasToolError, terminalCount, isLimited };
	}, [snapshot]);

	let summaryContent: React.ReactNode = null;

	if (status === "loading" && !snapshot) {
		summaryContent = <span className="text-muted-foreground">Загрузка...</span>;
	} else if (!counters || (counters.active === 0 && counters.terminalCount === 0)) {
		summaryContent = <span className="text-muted-foreground">Нет активных задач</span>;
	} else if (counters.active > 0) {
		const parts: string[] = [];
		parts.push(`${counters.active} активны${counters.active === 1 ? "а" : "х"}`);
		if (counters.waiting > 0) {
			parts.push(`${counters.waiting} ожидает`);
		}
		if (counters.sleeping > 0) {
			parts.push(`${counters.sleeping} на таймере`);
		}
		summaryContent = (
			<span className="font-medium text-foreground">
				{parts.join(" · ")}
			</span>
		);
	} else {
		summaryContent = (
			<span className="text-muted-foreground">
				Завершено ({counters.terminalCount})
			</span>
		);
	}

	return (
		<button
			type="button"
			onClick={onToggle}
			className="flex items-center gap-2 px-2 py-1 text-xs select-none rounded hover:bg-muted/40 hover:shadow-sm transition-colors duration-150 cursor-pointer"
		>
			<span className="text-blue-500 flex items-center justify-center">
				<Icon name={counters?.active ? "Play" : "Check"} className="w-3.5 h-3.5" />
			</span>

			<span className="font-semibold text-foreground">Ход выполнения</span>
			<span className="text-muted-foreground">·</span>
			{summaryContent}

			{counters?.hasToolError ? (
				<span className="text-[10px] px-1 py-0.2 bg-red-500/10 text-red-600 dark:text-red-400 rounded">
					ошибка
				</span>
			) : null}

			{counters?.isLimited ? (
				<span className="text-[10px] px-1 py-0.2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded">
					Лимит
				</span>
			) : null}

			<span className="text-muted-foreground ml-1">
				<Icon name={isExpanded ? "ChevronUp" : "ChevronDown"} className="w-3 h-3" />
			</span>
		</button>
	);
};
