import type { DurableView } from "./runtime-types.ts";
import type { GraphScope, RuntimeGraphSnapshot, RuntimeTaskNode } from "../runtime-graph/types.ts";
import { MAX_LIVE_NODES } from "../runtime-graph/schema.ts";
import { RuntimeGraphReceiptsCollector } from "./runtime-graph-receipts.ts";
import { RuntimeGraphConversations } from "./runtime-graph-conversations.ts";
import { TaskNames } from "./task-labels.ts";
import {
	extractTaskGraph,
	recordSubagentOwnership,
	buildMappedNode,
	recordTerminalWithDetails,
	type ViewSource,
	type HarnessGraphSource,
	type RuntimeGraphSourceOptions,
} from "./runtime-graph-mapper.ts";

export type { ViewSource, HarnessGraphSource, RuntimeGraphSourceOptions };

export class RuntimeGraphSource {
	private readonly viewSource: ViewSource;
	private readonly scope: GraphScope;
	private readonly debounceMs: number;
	private readonly maxDebounceMs: number;
	private readonly clock: () => number;
	private readonly receipts: RuntimeGraphReceiptsCollector;
	private readonly harness?: HarnessGraphSource;
	private readonly names = new TaskNames();
	private readonly listeners = new Set<(snapshot: RuntimeGraphSnapshot) => void>();
	private readonly epoch: string;
	private readonly conversations: RuntimeGraphConversations;
	private readonly nativeStartedAt = new Map<number, number>();

	private revision = 0;
	private previousNodes = new Map<number, { conversationId: number; kind: string }>();
	private lastStructuralJson = "";
	private timer?: ReturnType<typeof setTimeout>;
	private firstScheduledAt?: number;
	private unsubscribeView?: () => void;
	private unsubscribeCommits?: () => void;
	private isDisposed = false;

	constructor(viewSource: ViewSource, scope: GraphScope, options?: RuntimeGraphSourceOptions) {
		this.viewSource = viewSource;
		this.scope = scope;
		this.debounceMs = options?.debounceMs ?? 250;
		this.maxDebounceMs = options?.maxDebounceMs ?? 1000;
		this.clock = options?.clock ?? Date.now;
		this.receipts = options?.receipts ?? new RuntimeGraphReceiptsCollector();
		this.harness = options?.harness;
		this.epoch = `epoch_${this.clock()}_${Math.random().toString(36).slice(2, 7)}`;
		this.conversations = new RuntimeGraphConversations(this.scope.rootConversationId);

		if (this.harness?.subscribeCommits) {
			this.unsubscribeCommits = this.harness.subscribeCommits((pub) => {
				for (const ch of pub.changes as Array<{ type?: string; value?: any }>) {
					if (ch?.type === "task") {
						const taskVal = ch.value;
						const idNum = Number(taskVal?.id);
						if (taskVal?.startedAt) this.nativeStartedAt.set(idNum, Number(taskVal.startedAt));
						if (taskVal?.state?.status === "terminal") {
							this.learnNames();
							recordTerminalWithDetails(this.receipts, taskVal, this.names, this.nativeStartedAt);
						}
						this.schedule();
					} else if (ch?.type === "conversation" && ch.value) {
						this.conversations.recordConversation(ch.value);
						this.schedule();
					}
				}
			});
		}
		this.unsubscribeView = this.viewSource.subscribe(() => this.schedule());
		this.schedule();
	}

	subscribe(listener: (snapshot: RuntimeGraphSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	teardown(): void {
		if (this.isDisposed) return;
		this.isDisposed = true;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
			this.publish();
		}
		this.unsubscribeCommits?.();
		this.unsubscribeView?.();
		this.listeners.clear();
	}

	private schedule(): void {
		if (this.isDisposed) return;
		const now = this.clock();
		if (this.firstScheduledAt === undefined) this.firstScheduledAt = now;
		const elapsed = now - this.firstScheduledAt;
		if (elapsed >= this.maxDebounceMs) {
			clearTimeout(this.timer);
			this.timer = undefined;
			this.publish();
			return;
		}
		clearTimeout(this.timer);
		const delay = Math.min(this.debounceMs, this.maxDebounceMs - elapsed);
		this.timer = setTimeout(() => { this.timer = undefined; this.publish(); }, Math.max(0, delay));
	}

	private publish(): void {
		this.firstScheduledAt = undefined;
		if (this.isDisposed) return;

		const current = this.viewSource.current();
		this.learnNames(current);
		const rawNodes = extractTaskGraph(current).tasks ?? {};
		const totalLiveCount = Object.keys(rawNodes).length;
		const liveNodeEntries = Object.entries(rawNodes).slice(0, MAX_LIVE_NODES);
		const currentLiveIds = new Set<number>();
		const mappedNodes: Record<string, RuntimeTaskNode> = {};
		const rootConvId = Number(this.scope.rootConversationId);

		for (const [key, node] of liveNodeEntries) {
			currentLiveIds.add(Number(node.id));
			this.conversations.recordFromLiveNode(Number(node.conversationId), Number(node.id), node.conversations);
			mappedNodes[key] = buildMappedNode(node, current, rootConvId, this.names, this.nativeStartedAt, this.clock);
		}

		const hasMissingReceipts = this.reconcileDisappearedNodes(currentLiveIds);
		this.previousNodes = new Map(
			liveNodeEntries.map(([_, n]) => [Number(n.id), { conversationId: Number(n.conversationId), kind: n.kind }]),
		);

		const completeness = (totalLiveCount > MAX_LIVE_NODES || hasMissingReceipts) ? "limited" : "complete";
		const conversations = this.conversations.snapshot();
		const receipts = this.receipts.getReceipts();
		const allTaskIds = new Set<number>();
		for (const key of Object.keys(rawNodes)) allTaskIds.add(Number(key));
		for (const r of receipts) allTaskIds.add(r.taskId);
		const stats = { liveCount: Object.keys(mappedNodes).length, terminalCount: receipts.length, totalCount: allTaskIds.size };

		const structuralJson = JSON.stringify({ nodes: mappedNodes, conversations, receipts, completeness, stats });
		if (structuralJson === this.lastStructuralJson) return;
		this.lastStructuralJson = structuralJson;

		const snapshot: RuntimeGraphSnapshot = {
			version: 1, scope: this.scope,
			observation: { epoch: this.epoch, revision: ++this.revision, observedAt: this.clock(), completeness },
			nodes: mappedNodes, conversations, receipts, stats,
		};
		for (const listener of this.listeners) listener(snapshot);
	}

	private learnNames(current?: unknown): void {
		const cur = current ?? this.viewSource.current();
		if (cur && typeof cur === "object" && "session" in cur && "conversation" in cur) {
			this.names.learn(cur as DurableView);
		}
		recordSubagentOwnership(this.conversations, cur, this.scope.rootConversationId);
	}

	private reconcileDisappearedNodes(currentLiveIds: Set<number>): boolean {
		let hasMissing = false;
		for (const [prevId] of this.previousNodes) {
			if (!currentLiveIds.has(prevId) && !this.receipts.hasReceipt(prevId)) {
				hasMissing = true;
				if (this.harness?.getTask) {
					void this.harness.getTask(prevId).then((task) => {
						if (task && task.state?.status === "terminal") {
							this.learnNames();
							recordTerminalWithDetails(this.receipts, task, this.names, this.nativeStartedAt);
							this.schedule();
						}
					}).catch(() => {});
				}
			}
		}
		return hasMissing;
	}
}
