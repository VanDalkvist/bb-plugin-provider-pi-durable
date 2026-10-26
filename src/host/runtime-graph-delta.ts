import type { ThreadDelta } from "./types.ts";
import type { RuntimeGraphSnapshot } from "../runtime-graph/types.ts";
import { filterSnapshotForConversation } from "../runner/runtime-graph-scope.ts";

export const RUNTIME_GRAPH_EXTENSION_KIND = "provider-pi-durable/runtime-graph";

export function translateRuntimeGraphSnapshot(
	event: { readonly snapshot: RuntimeGraphSnapshot; readonly conversationId?: string | number },
	targetConversationId?: string | number,
): ThreadDelta[] {
	let snapshot = event.snapshot;

	if (
		targetConversationId !== undefined &&
		Number(targetConversationId) !== Number(snapshot.scope.rootConversationId)
	) {
		snapshot = filterSnapshotForConversation(snapshot, targetConversationId);
	}

	return [
		{
			kind: "extension.state",
			extensionKind: RUNTIME_GRAPH_EXTENSION_KIND,
			payload: snapshot,
		},
	];
}
