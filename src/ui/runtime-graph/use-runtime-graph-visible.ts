import { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";

export interface ThreadContextSegmentInput {
	readonly threadId: string;
	readonly projectId: string;
	readonly environment: unknown | null;
}

export function useRuntimeGraphVisible(
	input: ThreadContextSegmentInput,
	testEnv?: { sidebarThreads?: { status: string; threads: Array<{ id: string; providerId: string }> } },
): boolean {
	let sidebar: { status: string; threads: readonly { id: string; providerId: string }[] } | undefined;
	try {
		sidebar = testEnv?.sidebarThreads ?? (experimental_useSidebarThreads() as any);
	} catch {
		return true;
	}

	if (sidebar?.status === "ready" && Array.isArray(sidebar.threads) && sidebar.threads.length > 0) {
		const thread = sidebar.threads.find((t) => t.id === input.threadId);
		if (thread) {
			return thread.providerId === "pi-durable";
		}
	}

	return true;
}
