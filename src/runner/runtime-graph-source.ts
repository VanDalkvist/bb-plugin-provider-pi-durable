import type { TaskGraphNode, TaskRecord } from "@earendil-works/pi-durable";
import type { DurableView } from "./runtime-types.ts";
import type { GraphScope, RuntimeGraphSnapshot, RuntimeTaskNode } from "../runtime-graph/types.ts";
import { MAX_LIVE_NODES, MAX_LABEL_LENGTH } from "../runtime-graph/schema.ts";
import { RuntimeGraphReceiptsCollector } from "./runtime-graph-receipts.ts";
import { RuntimeGraphConversations } from "./runtime-graph-conversations.ts";
import { TaskNames, taskLabel } from "./task-labels.ts";
import { extractTaskGraph, mapTaskGraphNodeState } from "./runtime-graph-mapper.ts";

export interface ViewSource {
	current(): { tasks?: unknown } | undefined;
	subscribe(listener: () => void): () => void;
}

export interface HarnessGraphSource {
	getTask?(id: unknown, context?: unknown): Promise<TaskRecord<unknown, unknown, unknown> | undefined>;
	subscribeCommits?(listener: (publication: { readonly changes: readonly unknown[] }, context?: unknown) => void): () => void;
}

export interface RuntimeGraphSourceOptions {
	readonly debounceMs?: number;
	readonly maxDebounceMs?: number;
	readonly clock?: () => number;
	readonly receipts?: RuntimeGraphReceiptsCollector;
	readonly harness?: HarnessGraphSource;
}

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
					if (ch?.type === "task" && (ch.value?.state?.status === "terminal" || ch.value?.state?.status === "completing")) {
						this.receipts.recordTerminal(ch.value);
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
		if (current && "session" in current && "conversation" in current) {
			this.names.learn(current as DurableView);
		}
		const rawNodes = extractTaskGraph(current).tasks ?? {};
		const totalLiveCount = Object.keys(rawNodes).length;
		const liveNodeEntries = Object.entries(rawNodes).slice(0, MAX_LIVE_NODES);
		const currentLiveIds = new Set<number>();
		const mappedNodes: Record<string, RuntimeTaskNode> = {};

		for (const [key, node] of liveNodeEntries) {
			const id = Number(node.id);
			currentLiveIds.add(id);
			const convId = Number(node.conversationId);
			this.conversations.recordFromLiveNode(convId, id, node.conversations);
			let label = taskLabel(node, this.names);
			if (label.length > MAX_LABEL_LENGTH) label = label.slice(0, MAX_LABEL_LENGTH);

			mappedNodes[key] = {
				id, kind: node.kind, conversationId: convId,
				owner: node.owner !== undefined ? Number(node.owner) : undefined,
				background: Boolean(node.background), abortRequested: Boolean(node.abortRequested),
				state: mapTaskGraphNodeState(node.state), blocked: node.blocked, label,
			};
		}

		const hasMissingReceipts = this.reconcileDisappearedNodes(currentLiveIds);
		this.previousNodes = new Map(
			liveNodeEntries.map(([_, n]) => [Number(n.id), { conversationId: Number(n.conversationId), kind: n.kind }]),
		);

		const completeness = (totalLiveCount > MAX_LIVE_NODES || hasMissingReceipts) ? "limited" : "complete";
		const conversations = this.conversations.snapshot();
		const receipts = this.receipts.getReceipts();
		const stats = { liveCount: Object.keys(mappedNodes).length, terminalCount: receipts.length, totalCount: totalLiveCount + receipts.length };

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

	private reconcileDisappearedNodes(currentLiveIds: Set<number>): boolean {
		let hasMissing = false;
		for (const [prevId] of this.previousNodes) {
			if (!currentLiveIds.has(prevId) && !this.receipts.hasReceipt(prevId)) {
				hasMissing = true;
				if (this.harness?.getTask) {
					void this.harness.getTask(prevId).then((task) => {
						if (task && (task.state?.status === "terminal" || task.state?.status === "completing")) {
							this.receipts.recordTerminal(task);
							this.schedule();
						}
					}).catch(() => {});
				}
			}
		}
		return hasMissing;
	}
}
