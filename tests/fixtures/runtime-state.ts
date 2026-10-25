import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { RuntimeReadBinding } from "../../src/runner/runtime-types.ts";

export function trackedBinding<T>(initial: T, failSubscribe = false) {
	let value = initial, subscriptions = 0, disposals = 0, unsubscribes = 0;
	let stale: ((value: T) => void) | undefined;
	const observers = new Set<(value: T) => void>();
	const binding: RuntimeReadBinding<T> = {
		get value() { return value; },
		subscribe(listener) {
			if (failSubscribe) throw new Error("SUBSCRIBE_FAILED");
			subscriptions++; observers.add(listener); stale = listener;
			return () => { unsubscribes++; observers.delete(listener); };
		},
		dispose() { disposals++; },
	};
	return {
		binding,
		emit(next: T) { value = next; for (const observer of observers) observer(next); },
		emitStale(next: T) { stale?.(next); },
		counts: () => ({ subscriptions, disposals, unsubscribes }),
	};
}

export async function nativeRuntimeState() {
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
	const root = await harness.root(context);
	const child = await harness.createConversation({ ownership: { kind: "session" } }, context);
	const view = await root.viewState(context);
	const conversation = view.value;
	view.dispose();
	const graph = await harness.taskGraph(context);
	const tasks = graph.value;
	graph.dispose();
	return { harness, root, child, conversation, tasks, close: () => harness.close(context) };
}
