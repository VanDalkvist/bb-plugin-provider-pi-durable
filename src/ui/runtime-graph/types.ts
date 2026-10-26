import type {
	RuntimeGraphSnapshot,
	RuntimeTaskNode,
	RuntimeTaskReceipt,
} from "../../runtime-graph/types.ts";

export interface TaskTreeItem {
	readonly id: number;
	readonly kind: string;
	readonly label: string;
	readonly conversationId: number;
	readonly ownerId?: number;
	readonly isTerminal: boolean;
	readonly liveNode?: RuntimeTaskNode;
	readonly receipt?: RuntimeTaskReceipt;
	readonly waitingOn?: readonly number[];
	readonly children: TaskTreeItem[];
}

export interface RuntimeGraphState {
	readonly threadId: string;
	readonly status: "loading" | "ok" | "unavailable";
	readonly snapshot: RuntimeGraphSnapshot | null;
	readonly tree: readonly TaskTreeItem[];
	readonly selectedTaskId: number | null;
	readonly selectedItem: TaskTreeItem | null;
	readonly collapsedTaskIds: ReadonlySet<number>;
	selectTask(id: number | null): void;
	toggleCollapse(id: number): void;
}
