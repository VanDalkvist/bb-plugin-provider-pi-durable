import React, { type FC } from "react";
import { experimental_DetailRow, experimental_InfoSection, experimental_Icon } from "@get-bb/plugin-sdk/app";
import { projectTaskState, projectTaskReceipt } from "../../runtime-graph/status.ts";
import type { TaskTreeItem } from "./types.ts";
import { hasActiveWork } from "./tree-order.ts";
import { formatDetailedTokens } from "./token-format.ts";

export interface RuntimeGraphDetailsProps {
	readonly selectedItem: TaskTreeItem | null;
	readonly now?: number;
	readonly onClose?: () => void;
}

export const RuntimeGraphDetails: FC<RuntimeGraphDetailsProps> = ({ selectedItem, now, onClose }) => {
	const DetailRow = experimental_DetailRow;
	const InfoSection = experimental_InfoSection;
	const Icon = experimental_Icon;

	if (!selectedItem) return null;

	const { id, kind, conversationId, ownerId, liveNode, receipt } = selectedItem;
	const projectedLive = liveNode ? projectTaskState(liveNode) : null;
	const projectedReceipt = receipt ? projectTaskReceipt(receipt) : null;

	const isActive = hasActiveWork(selectedItem);
	const previewText = receipt?.preview;
	const errorInfo = receipt?.error;
	const startedAt = liveNode?.startedAt ?? receipt?.startedAt;
	const liveElapsed = startedAt && startedAt > 0 ? Math.max(0, (now ?? Date.now()) - startedAt) : liveNode?.durationMs;
	const durationMs = isActive ? liveElapsed : (receipt?.durationMs ?? liveElapsed);

	const isSubagent = kind.includes("subagent") || liveNode?.toolName === "subagent" || receipt?.toolName === "subagent";
	const subagentTask = isSubagent ? (receipt?.preview ?? liveNode?.targetHint ?? receipt?.targetHint) : undefined;
	const tokensStr = formatDetailedTokens(liveNode?.tokens ?? receipt?.tokens);

	return (
		<div className="flex flex-col h-full min-h-0 text-xs">
			<div className="flex items-center justify-between pb-1.5 px-0.5 border-b border-border flex-shrink-0">
				<span className="font-semibold text-xs text-foreground">Task Details</span>
				{onClose ? (
					<button
						type="button"
						onClick={onClose}
						onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClose(); } }}
						aria-label="Close task details"
						className="text-xs text-muted-foreground hover:text-foreground p-1 rounded hover:bg-state-hover transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						<Icon name="X" className="w-3.5 h-3.5" />
					</button>
				) : null}
			</div>

			<div className="flex-1 overflow-y-auto min-h-0 space-y-3.5 pt-2 pr-0.5">
				<InfoSection label={`Task #${id}`}>
					<DetailRow label="Task ID"><span className="font-mono">#{id}</span></DetailRow>
					<DetailRow label="Task type"><span className="font-mono">{kind}</span></DetailRow>
					<DetailRow label="Conversation"><span className="font-mono">#{conversationId}</span></DetailRow>
					<DetailRow label="Owner"><span className="font-mono">{ownerId !== undefined ? `#${ownerId}` : "— (root)"}</span></DetailRow>

					{liveNode?.toolName || receipt?.toolName ? (
						<DetailRow label="Tool"><span className="font-mono">{liveNode?.toolName ?? receipt?.toolName}</span></DetailRow>
					) : null}

					{liveNode?.targetHint || receipt?.targetHint ? (
						<DetailRow label="Target">
							<span className="font-mono break-words break-all [overflow-wrap:anywhere] min-w-0" title={liveNode?.targetHint ?? receipt?.targetHint}>
								{liveNode?.targetHint ?? receipt?.targetHint}
							</span>
						</DetailRow>
					) : null}

					{liveNode?.model ? (
						<DetailRow label="Model"><span className="font-mono">{liveNode.model.provider}/{liveNode.model.modelId}</span></DetailRow>
					) : null}

					{liveNode?.thinkingLevel ? (
						<DetailRow label="Thinking"><span className="font-mono">{liveNode.thinkingLevel}</span></DetailRow>
					) : null}

					{tokensStr ? (
						<DetailRow label="Tokens"><span className="font-mono text-[11px]">{tokensStr}</span></DetailRow>
					) : null}

					{isActive ? (
						<DetailRow label="Runtime status">
							<span className="font-medium text-blue-500">Running in background</span>
						</DetailRow>
					) : projectedLive ? (
						<DetailRow label="Runtime status">
							<span className="font-medium text-blue-500">{projectedLive.label}</span>
						</DetailRow>
					) : null}

					{liveNode?.state && "phase" in liveNode.state && liveNode.state.phase ? (
						<DetailRow label="Execution phase"><span className="font-mono">{liveNode.state.phase}</span></DetailRow>
					) : null}

					{projectedLive?.waitingOn && projectedLive.waitingOn.length > 0 ? (
						<DetailRow label="Waiting on tasks">
							<span className="font-mono">#{projectedLive.waitingOn.join(", #")}</span>
						</DetailRow>
					) : null}

					{projectedLive?.sleepUntil ? (
						<DetailRow label="Timer until"><span>{new Date(projectedLive.sleepUntil).toLocaleTimeString()}</span></DetailRow>
					) : null}

					{!isActive && projectedReceipt ? (
						<>
							<DetailRow label="Outcome">
								<span className={`font-medium ${projectedReceipt.outcome === "completed" ? "text-green-500" : "text-red-500"}`}>
									{projectedReceipt.label}
								</span>
							</DetailRow>
							{projectedReceipt.hasToolError ? (
								<DetailRow label="Tool status"><span className="text-red-500 font-medium">Tool error</span></DetailRow>
							) : null}
						</>
					) : null}

					{durationMs !== undefined ? (
						<DetailRow label="Duration">
							<span>{durationMs < 1000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1000).toFixed(1)} s`}</span>
						</DetailRow>
					) : null}

					{startedAt ? (
						<DetailRow label="Started at"><span>{new Date(startedAt).toLocaleTimeString()}</span></DetailRow>
					) : null}
				</InfoSection>

				{subagentTask ? (
					<InfoSection label="Subagent task">
						<pre className="p-2 bg-muted/30 rounded border border-border text-[11px] font-mono whitespace-pre-wrap break-all [overflow-wrap:anywhere] max-h-32 overflow-y-auto">
							{subagentTask}
						</pre>
					</InfoSection>
				) : null}

				{!isSubagent && previewText ? (
					<InfoSection label="Execution output">
						<pre className="p-2 bg-muted/40 rounded border text-[11px] font-mono whitespace-pre-wrap break-all [overflow-wrap:anywhere] max-h-40 overflow-y-auto">
							{previewText}
						</pre>
					</InfoSection>
				) : null}

				{errorInfo ? (
					<InfoSection label="Error diagnostics">
						<div className="space-y-1.5 p-2 bg-red-500/10 border border-red-500/20 rounded">
							{errorInfo.code ? (
								<div className="font-mono text-[10px] text-red-600 dark:text-red-400 font-semibold break-all [overflow-wrap:anywhere]">
									Error code: {errorInfo.code}
								</div>
							) : null}
							<pre className="text-[11px] font-mono text-red-600 dark:text-red-400 whitespace-pre-wrap break-all [overflow-wrap:anywhere] max-h-40 overflow-y-auto">
								{errorInfo.message}
							</pre>
						</div>
					</InfoSection>
				) : null}
			</div>
		</div>
	);
};
