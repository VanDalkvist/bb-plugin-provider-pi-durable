import React, { type FC } from "react";

export interface NodeRowWaitingPillsProps {
	readonly waitingOn?: readonly number[];
	readonly onSelectTaskId?: (taskId: number) => void;
}

export const NodeRowWaitingPills: FC<NodeRowWaitingPillsProps> = ({
	waitingOn,
	onSelectTaskId,
}) => {
	if (!waitingOn || waitingOn.length === 0) return null;

	return (
		<span className="text-[10px] px-1 py-0.2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded flex items-center gap-1 select-none flex-shrink-0">
			<span>waits:</span>
			{waitingOn.map((id) => (
				<span
					key={id}
					role="button"
					tabIndex={0}
					aria-label={`Select task #${id}`}
					onClick={(e) => {
						e.stopPropagation();
						onSelectTaskId?.(id);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							e.stopPropagation();
							onSelectTaskId?.(id);
						}
					}}
					className="hover:underline font-mono font-medium focus:outline-none cursor-pointer"
					title={`Select task #${id}`}
				>
					#{id}
				</span>
			))}
		</span>
	);
};
