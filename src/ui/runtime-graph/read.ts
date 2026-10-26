import type { RuntimeGraphSnapshot } from "../../runtime-graph/types.ts";
import { runtimeGraphSnapshotSchema } from "../../runtime-graph/schema.ts";
import { RUNTIME_GRAPH_EXTENSION_KIND } from "../../host/runtime-graph-delta.ts";
import { filterSnapshotForConversation } from "../../runner/runtime-graph-scope.ts";

export const MAX_EVENT_PAGES = 5;
export const PAGE_SIZE = "100";

export interface ReadRuntimeGraphOptions {
	readonly conversationId?: number;
	readonly signal?: AbortSignal;
}

export type ReadRuntimeGraphResult =
	| { readonly status: "ok"; readonly snapshot: RuntimeGraphSnapshot }
	| {
			readonly status: "unavailable";
			readonly reason: "no_events" | "invalid_payload" | "page_cap_reached" | "aborted";
	  };

export interface RuntimeGraphEventsClient {
	readonly threads: {
		readonly events: {
			list(args: {
				readonly threadId: string;
				readonly types?: readonly string[];
				readonly order?: "asc" | "desc";
				readonly limit?: string;
				readonly beforeSeq?: string;
				readonly signal?: AbortSignal;
			}): Promise<readonly unknown[]>;
		};
	};
}

interface ThreadEventRow {
	readonly type: string;
	readonly kind?: string;
	readonly extensionKind?: string;
	readonly payload?: unknown;
	readonly data?: {
		readonly kind?: string;
		readonly extensionKind?: string;
		readonly payload?: unknown;
	};
	readonly seq?: number | string;
}

export async function readRuntimeGraphSnapshot(
	sdk: RuntimeGraphEventsClient,
	threadId: string,
	options?: ReadRuntimeGraphOptions,
): Promise<ReadRuntimeGraphResult> {
	let beforeSeq: string | undefined;
	let pagesFetched = 0;
	let totalEventsInspected = 0;

	while (pagesFetched < MAX_EVENT_PAGES) {
		if (options?.signal?.aborted) {
			return { status: "unavailable", reason: "aborted" };
		}

		pagesFetched++;
		let rows: readonly unknown[];
		try {
			rows = await sdk.threads.events.list({
				threadId,
				types: ["thread/extensionState/updated"],
				order: "desc",
				limit: PAGE_SIZE,
				beforeSeq,
				signal: options?.signal,
			});
		} catch (err: unknown) {
			if (options?.signal?.aborted) {
				return { status: "unavailable", reason: "aborted" };
			}
			return { status: "unavailable", reason: "no_events" };
		}

		if (!Array.isArray(rows) || rows.length === 0) {
			if (totalEventsInspected === 0) {
				return { status: "unavailable", reason: "no_events" };
			}
			break;
		}

		totalEventsInspected += rows.length;

		for (const raw of rows) {
			const row = raw as ThreadEventRow;
			const kind = row.kind ?? row.data?.kind ?? row.extensionKind ?? row.data?.extensionKind;
			const payload = row.payload ?? row.data?.payload;
			if (kind === RUNTIME_GRAPH_EXTENSION_KIND && payload !== undefined) {
				const parsed = runtimeGraphSnapshotSchema.safeParse(payload);
				if (parsed.success) {
					let snapshot = parsed.data as unknown as RuntimeGraphSnapshot;
					if (options?.conversationId !== undefined) {
						snapshot = filterSnapshotForConversation(snapshot, options.conversationId);
					}
					return { status: "ok", snapshot };
				}
			}
		}

		const lastRow = rows[rows.length - 1] as ThreadEventRow | undefined;
		if (lastRow?.seq !== undefined) {
			beforeSeq = String(lastRow.seq);
		} else {
			break;
		}
	}

	return {
		status: "unavailable",
		reason: totalEventsInspected === 0 ? "no_events" : "page_cap_reached",
	};
}

