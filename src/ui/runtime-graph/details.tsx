import React, { type FC } from "react";
import { experimental_DetailRow, experimental_InfoSection } from "@get-bb/plugin-sdk/app";
import { projectTaskState, projectTaskReceipt } from "../../runtime-graph/status.ts";
import type { TaskTreeItem } from "./types.ts";

export interface RuntimeGraphDetailsProps {
	readonly selectedItem: TaskTreeItem | null;
	readonly now?: number;
	readonly onClose?: () => void;
}

export const RuntimeGraphDetails: FC<RuntimeGraphDetailsProps> = ({ selectedItem, now, onClose }) => {
	const DetailRow = experimental_DetailRow;
	const InfoSection = experimental_InfoSection;

	if (!selectedItem) {
		return null;
	}

	const { id, kind, conversationId, ownerId, liveNode, receipt } = selectedItem;
	const projectedLive = liveNode ? projectTaskState(liveNode) : null;
	const projectedReceipt = receipt ? projectTaskReceipt(receipt) : null;

	const previewText = receipt?.preview;
	const errorInfo = receipt?.error;
	const liveElapsed = liveNode?.durationMs ?? (
		liveNode?.startedAt && liveNode.startedAt > 0
			? Math.max(0, (now ?? Date.now()) - liveNode.startedAt)
			: undefined
	);
	const durationMs = receipt?.durationMs ?? liveElapsed;

	return (
		<div className="space-y-4 text-xs">
			<div className="flex items-center justify-between pb-1 border-b">
				<span className="font-semibold text-xs text-foreground">Task Details</span>
				{onClose ? (
					<button
						type="button"
						onClick={onClose}
						aria-label="Close inspector"
						className="text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted/60 transition-colors cursor-pointer"
					>
						Close
					</button>
				) : null}
			</div>

			<InfoSection label={`Task #${id}`}>
				<DetailRow label="Task ID">
					<span className="font-mono">#{id}</span>
				</DetailRow>

				<DetailRow label="Task type">
					<span className="font-mono">{kind}</span>
				</DetailRow>

				<DetailRow label="Conversation">
					<span className="font-mono">#{conversationId}</span>
				</DetailRow>

				<DetailRow label="Owner">
					<span className="font-mono">{ownerId !== undefined ? `#${ownerId}` : "— (root)"}</span>
				</DetailRow>

				{liveNode?.toolName || receipt?.toolName ? (
					<DetailRow label="Tool">
						<span className="font-mono">{liveNode?.toolName ?? receipt?.toolName}</span>
					</DetailRow>
				) : null}

				{liveNode?.targetHint || receipt?.targetHint ? (
					<DetailRow label="Target">
						<span className="font-mono truncate max-w-[200px]" title={liveNode?.targetHint ?? receipt?.targetHint}>
							{liveNode?.targetHint ?? receipt?.targetHint}
						</span>
					</DetailRow>
				) : null}

				{liveNode?.model ? (
					<DetailRow label="Model">
						<span className="font-mono">{liveNode.model.provider}/{liveNode.model.modelId}</span>
					</DetailRow>
				) : null}

				{liveNode?.thinkingLevel ? (
					<DetailRow label="Thinking">
						<span className="font-mono">{liveNode.thinkingLevel}</span>
					</DetailRow>
				) : null}

				{projectedLive ? (
					<>
						<DetailRow label="Runtime status">
							<span className="font-medium text-blue-500">{projectedLive.label}</span>
						</DetailRow>

						{liveNode?.state && "phase" in liveNode.state && liveNode.state.phase ? (
							<DetailRow label="Execution phase">
								<span className="font-mono">{liveNode.state.phase}</span>
							</DetailRow>
						) : null}

						{projectedLive.waitingOn && projectedLive.waitingOn.length > 0 ? (
							<DetailRow label="Waiting on tasks">
								<span className="font-mono">
									#{projectedLive.waitingOn.join(", #")}
									{liveNode?.state.status === "waiting" && liveNode.state.policy
										? ` (${liveNode.state.policy})`
										: null}
								</span>
							</DetailRow>
						) : null}

						{projectedLive.sleepUntil ? (
							<DetailRow label="Timer until">
								<span>{new Date(projectedLive.sleepUntil).toLocaleTimeString()}</span>
							</DetailRow>
						) : null}

						{projectedLive.blockedReason ? (
							<DetailRow label="Blocked">
								<span className="text-amber-500">{projectedLive.blockedReason}</span>
							</DetailRow>
						) : null}
					</>
				) : null}

				{projectedReceipt ? (
					<>
						<DetailRow label="Outcome">
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
							<DetailRow label="Tool status">
								<span className="text-red-500 font-medium">Tool error</span>
							</DetailRow>
						) : null}
					</>
				) : null}

				{durationMs !== undefined ? (
					<DetailRow label="Duration">
						<span>{durationMs < 1000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1000).toFixed(1)} s`}</span>
					</DetailRow>
				) : null}

				{liveNode?.startedAt || receipt?.startedAt ? (
					<DetailRow label="Started at">
						<span>{new Date(liveNode?.startedAt ?? receipt!.startedAt!).toLocaleTimeString()}</span>
					</DetailRow>
				) : null}
			</InfoSection>

			{previewText ? (
				<InfoSection label="Execution output">
					<pre className="p-2 bg-muted/40 rounded border text-[11px] font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
						{previewText}
					</pre>
				</InfoSection>
			) : null}

			{errorInfo ? (
				<InfoSection label="Error diagnostics">
					<div className="space-y-1.5 p-2 bg-red-500/10 border border-red-500/20 rounded">
						{errorInfo.code ? (
							<div className="font-mono text-[10px] text-red-600 dark:text-red-400 font-semibold">
								Error code: {errorInfo.code}
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
