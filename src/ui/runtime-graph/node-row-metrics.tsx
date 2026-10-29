import React, { type FC } from "react";
import { SparklesIcon } from "./token-icon.tsx";

export interface NodeRowMetricsProps {
	readonly tokenCountStr?: string | null;
	readonly tokenTitle?: string;
	readonly duration?: string | null;
}

/**
 * Renders fixed-width tabular metrics for task graph rows:
 * [ SparklesIcon + tokenCount ] · [ duration ]
 * Numbers and icons start from fixed invisible vertical lines so rows never wobble.
 * Colors are muted (matching digits) to avoid visual noise.
 */
export const NodeRowMetrics: FC<NodeRowMetricsProps> = ({
	tokenCountStr,
	tokenTitle,
	duration,
}) => {
	const hasMetrics = Boolean(tokenCountStr || duration);
	if (!hasMetrics) return null;

	return (
		<div className="ml-auto flex items-center flex-shrink-0 text-[10px] font-mono tabular-nums pl-2 select-none">
			{/* Token column: fixed width, starts from fixed vertical line */}
			<div className="w-[3.75rem] flex items-center justify-start gap-1 flex-shrink-0">
				{tokenCountStr ? (
					<span
						className="inline-flex items-center gap-1 text-muted-foreground/70 hover:text-foreground transition-colors cursor-default"
						title={tokenTitle}
					>
						<SparklesIcon className="w-2.5 h-2.5 text-muted-foreground/60 hover:text-foreground transition-colors flex-shrink-0" />
						<span>{tokenCountStr}</span>
					</span>
				) : null}
			</div>

			{/* Fixed separator */}
			<span className="text-muted-foreground/30 px-1.5 flex-shrink-0 select-none">·</span>

			{/* Duration column: fixed width, starts from fixed vertical line */}
			<div className="w-[3.25rem] flex items-center justify-start text-muted-foreground/70 flex-shrink-0">
				{duration ?? ""}
			</div>
		</div>
	);
};
