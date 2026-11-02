import type { Conversation, ConversationId, ConversationView, Cursor, Harness, TaskGraph } from "@earendil-works/pi-durable";
import { firstInput, type ConversationSummary, type RuntimeReadBinding, runtimeContext } from "./runtime-types.ts";

export function hydrateSessionActiveTools(
	rootAgent: { readonly tools?: readonly { readonly name: string }[] | undefined },
	activeEnvState: { readonly setActiveTools?: (tools: string[]) => void },
): void {
	if (Array.isArray(rootAgent.tools)) {
		activeEnvState.setActiveTools?.(rootAgent.tools.map((t) => t.name));
	}
}

export async function createConversationBinding(
	conversation: Conversation,
	ctx: typeof runtimeContext = runtimeContext,
): Promise<RuntimeReadBinding<ConversationView>> {
	if (typeof (conversation as any).viewState === "function") {
		return (conversation as any).viewState(ctx);
	}
	const watch = await conversation.watch(ctx);
	let currentVal = watch.value;
	const subscribers = new Set<(val: ConversationView) => void>();
	watch.start(async ({ value }: { value: ConversationView }) => {
		currentVal = value;
		for (const sub of subscribers) sub(value);
	});
	return {
		get value() { return currentVal; },
		subscribe(listener) {
			subscribers.add(listener);
			return () => subscribers.delete(listener);
		},
		dispose() {
			void watch.stop(ctx);
		},
	};
}

export async function createTaskGraphBinding(
	harness: Harness,
	ctx: typeof runtimeContext = runtimeContext,
): Promise<RuntimeReadBinding<TaskGraph>> {
	if (typeof (harness as any).taskGraph === "function") {
		return (harness as any).taskGraph(ctx);
	}
	const watch = await harness.watchTaskGraph(ctx);
	let currentVal = watch.value;
	const subscribers = new Set<(val: TaskGraph) => void>();
	watch.start(async ({ value }: { value: TaskGraph }) => {
		currentVal = value;
		for (const sub of subscribers) sub(value);
	});
	return {
		get value() { return currentVal; },
		subscribe(listener) {
			subscribers.add(listener);
			return () => subscribers.delete(listener);
		},
		dispose() {
			void watch.stop(ctx);
		},
	};
}

export async function loadSummaries(harness: Harness, rootId: ConversationId): Promise<ConversationSummary[]> {
	const summaries: ConversationSummary[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), runtimeContext);
		for (const { id } of page.items) summaries.push({ id, label: id === rootId ? "main" : `subagent ${id}`, ...(await firstInput(harness, id)) });
		cursor = page.next;
	} while (cursor !== undefined);
	return summaries;
}
