export interface WatchCallShape<T> {
	readonly kind: "value";
	readonly value: T;
	readonly ops?: readonly unknown[];
	readonly retired?: boolean;
}

export function isWatchCall<T>(item: unknown): item is WatchCallShape<T> {
	return (
		typeof item === "object" &&
		item !== null &&
		"kind" in item &&
		(item as { kind: string }).kind === "value" &&
		"value" in item
	);
}

export function unwrapWatchValue<T>(item: unknown): T {
	if (isWatchCall<T>(item)) {
		return item.value;
	}
	return item as T;
}
