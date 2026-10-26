import { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";

export interface ThreadContextSegmentInput {
	readonly threadId: string;
	readonly projectId: string;
	readonly environment: unknown | null;
}

export function useRuntimeGraphVisible(
	input: ThreadContextSegmentInput,
	testEnv?: {
		sidebarThreads?: { status: string; threads: readonly { id: string; providerId: string }[] };
		authoritativeProviderId?: string;
	},
): boolean {
	const sidebar = testEnv?.sidebarThreads ?? (experimental_useSidebarThreads({
		experimental_lifecycles: ["active", "archived"],
	}) as any);

	if (sidebar?.status === "ready" && Array.isArray(sidebar.threads)) {
		const thread = sidebar.threads.find((t: any) => t.id === input.threadId);
		if (thread) {
			return thread.providerId === "pi-durable";
		}
	}

	if (testEnv?.authoritativeProviderId !== undefined) {
		return testEnv.authoritativeProviderId === "pi-durable";
	}

	// Fail closed: never assume unknown foreign threads belong to pi-durable
	return false;
}
