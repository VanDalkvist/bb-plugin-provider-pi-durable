import React, { type FC } from "react";
import { experimental_DetailRow, experimental_InfoSection } from "@get-bb/plugin-sdk/app";
import { projectTaskState, projectTaskReceipt } from "../../runtime-graph/status.ts";
import type { TaskTreeItem } from "./types.ts";

export interface RuntimeGraphDetailsProps {
	readonly selectedItem: TaskTreeItem | null;
}

export const RuntimeGraphDetails: FC<RuntimeGraphDetailsProps> = ({ selectedItem }) => {
	const DetailRow = experimental_DetailRow;
	const InfoSection = experimental_InfoSection;

	if (!selectedItem) {
		return (
			<div className="flex items-center justify-center h-full p-4 text-xs text-muted-foreground text-center">
				Выберите узел в дереве для просмотра параметров и результатов
			</div>
		);
	}

	const { id, kind, conversationId, ownerId, liveNode, receipt } = selectedItem;
	const projectedLive = liveNode ? projectTaskState(liveNode) : null;
	const projectedReceipt = receipt ? projectTaskReceipt(receipt) : null;

	const previewText = receipt?.preview;
	const errorInfo = receipt?.error;
	const durationMs = receipt?.durationMs ?? liveNode?.durationMs;

	return (
		<div className="space-y-4 text-xs">
			<InfoSection label={`Задача #${id}`}>
				<DetailRow label="ID задачи">
					<span className="font-mono">#{id}</span>
				</DetailRow>

				<DetailRow label="Тип задачи">
					<span className="font-mono">{kind}</span>
				</DetailRow>

				<DetailRow label="Беседа">
					<span className="font-mono">#{conversationId}</span>
				</DetailRow>

				<DetailRow label="Владелец">
					<span className="font-mono">{ownerId !== undefined ? `#${ownerId}` : "— (корневая)"}</span>
				</DetailRow>

				{projectedLive ? (
					<>
						<DetailRow label="Статус рантайма">
							<span className="font-medium text-blue-500">{projectedLive.label}</span>
						</DetailRow>

						{liveNode?.state && "phase" in liveNode.state && liveNode.state.phase ? (
							<DetailRow label="Фаза выполнения">
								<span className="font-mono">{liveNode.state.phase}</span>
							</DetailRow>
						) : null}

						{projectedLive.waitingOn && projectedLive.waitingOn.length > 0 ? (
							<DetailRow label="Ожидает задач">
								<span className="font-mono">
									#{projectedLive.waitingOn.join(", #")}
									{liveNode?.state.status === "waiting" && liveNode.state.policy
										? ` (${liveNode.state.policy})`
										: null}
								</span>
							</DetailRow>
						) : null}

						{projectedLive.sleepUntil ? (
							<DetailRow label="Таймер до">
								<span>{new Date(projectedLive.sleepUntil).toLocaleTimeString()}</span>
							</DetailRow>
						) : null}

						{projectedLive.blockedReason ? (
							<DetailRow label="Блокировка">
								<span className="text-amber-500">{projectedLive.blockedReason}</span>
							</DetailRow>
						) : null}
					</>
				) : null}

				{projectedReceipt ? (
					<>
						<DetailRow label="Итог выполнения">
							<span
								className={`font-medium ${
									projectedReceipt.outcome === "completed"
										? "text-green-500"
										: "text-red-500"
								}`}
							>
								{projectedReceipt.label}
							</span>
						</DetailRow>

						{projectedReceipt.hasToolError ? (
							<DetailRow label="Статус инструмента">
								<span className="text-red-500 font-medium">Ошибка инструмента</span>
							</DetailRow>
						) : null}
					</>
				) : null}

				{durationMs !== undefined ? (
					<DetailRow label="Длительность">
						<span>{Math.round(durationMs)} мс</span>
					</DetailRow>
				) : null}
			</InfoSection>

			{previewText ? (
				<InfoSection label="Данные выполнения">
					<pre className="p-2 bg-muted/40 rounded border text-[11px] font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
						{previewText}
					</pre>
				</InfoSection>
			) : null}

			{errorInfo ? (
				<InfoSection label="Диагностика ошибки">
					<div className="space-y-1.5 p-2 bg-red-500/10 border border-red-500/20 rounded">
						{errorInfo.code ? (
							<div className="font-mono text-[10px] text-red-600 dark:text-red-400 font-semibold">
								Код ошибки: {errorInfo.code}
							</div>
						) : null}
						<pre className="text-[11px] font-mono text-red-600 dark:text-red-400 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
							{errorInfo.message}
						</pre>
					</div>
				</InfoSection>
			) : null}
		</div>
	);
};
