import React, { type FC } from "react";
import { SparklesIcon } from "./token-icon.tsx";

export interface NodeRowMetricsProps {
	readonly tokenDeltaStr?: string | null;
	readonly totalTokens?: number;
	readonly duration?: string | null;
}

/**
 * Renders fixed-width tabular metrics for task graph rows:
 * [ tokenDelta + SparklesIcon ] · [ duration ]
 * Numbers start from fixed invisible vertical lines so rows never wobble.
 */
export const NodeRowMetrics: FC<NodeRowMetricsProps> = ({
	tokenDeltaStr,
	totalTokens,
	duration,
}) => {
	const hasMetrics = Boolean(tokenDeltaStr || duration);
	if (!hasMetrics) return null;

	const tokenTitle = totalTokens
		? (tokenDeltaStr ? `${totalTokens.toLocaleString()} total tokens (${tokenDeltaStr} on this step)` : `${totalTokens.toLocaleString()} total tokens`)
		: undefined;

	return (
		<div className="ml-auto flex items-center flex-shrink-0 text-[10px] font-mono tabular-nums pl-2 select-none">
			{/* Token delta column: fixed width, starts from fixed vertical line */}
			<div className="w-[4.25rem] flex items-center justify-start gap-1 flex-shrink-0">
				{tokenDeltaStr ? (
					<span
						className="inline-flex items-center gap-1 text-muted-foreground/80 hover:text-foreground transition-colors cursor-default"
						title={tokenTitle}
					>
						<span>{tokenDeltaStr}</span>
						<SparklesIcon className="w-2.5 h-2.5 text-amber-500/80 dark:text-amber-400/80 flex-shrink-0" />
					</span>
				) : null}
			</div>

			{/* Fixed separator */}
			<span className="text-muted-foreground/30 px-1.5 flex-shrink-0 select-none">·</span>

			{/* Duration column: fixed width, starts from fixed vertical line */}
			<div className="w-[3.25rem] flex items-center justify-start text-muted-foreground flex-shrink-0">
				{duration ?? ""}
			</div>
		</div>
	);
};
