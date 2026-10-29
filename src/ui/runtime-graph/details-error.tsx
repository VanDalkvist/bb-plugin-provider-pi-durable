import React, { type FC } from "react";
import { experimental_InfoSection } from "@get-bb/plugin-sdk/app";

export interface DetailsErrorSectionProps {
	readonly errorInfo: { readonly code?: string; readonly message: string };
}

export const DetailsErrorSection: FC<DetailsErrorSectionProps> = ({ errorInfo }) => {
	const InfoSection = experimental_InfoSection;
	return (
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
	);
};
