import type { Context } from "@earendil-works/chord";
import type { CommitPublication, ConversationId, Cursor, Harness, TaskId } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { inspectNativeChildIntent, inspectNativeChildIdentity } from "./native-child-inspection.ts";
import { NativeChildDiscoverySchema, type NativeChildDiscovery } from "../native-child-discovery-contract.ts";

export type NativeChildDiscoveryTarget = { durableSessionId: string; parentThreadId: string; parentConversationId: ConversationId };
type Candidate = { childConversationId: ConversationId; taskId: TaskId };

/** Observe the installed Durable commit feed; only the original native creator may submit work. */
export class NativeChildDiscoveryObserver {
	private readonly seen = new Map<string, "intent" | "submitted">();
	private readonly unsubscribe: () => void;
	private readonly unsubscribeClose: () => void;
	private pending: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly harness: Harness;
	private readonly target: NativeChildDiscoveryTarget;
	private readonly context: Context;
	private readonly emit: (discovery: NativeChildDiscovery) => Promise<void>;
	private readonly onError: (error: unknown) => void;

	constructor(
		harness: Harness,
		target: NativeChildDiscoveryTarget,
		context: Context,
		emit: (discovery: NativeChildDiscovery) => Promise<void>,
		onError: (error: unknown) => void,
	) {
		this.harness = harness;
		this.target = target;
		this.context = context;
		this.emit = emit;
		this.onError = onError;
		this.unsubscribe = harness.subscribeCommits((publication) => this.onCommit(publication));
		this.unsubscribeClose = harness.subscribeClose(() => this.close());
	}

	private enqueue(candidate: Candidate): void {
		this.pending = this.pending.then(async () => {
			if (this.closed) return;
			const request = { ...this.target, childConversationId: candidate.childConversationId, taskId: candidate.taskId };
			const intent = await inspectNativeChildIntent(this.harness, this.target.durableSessionId, request, this.context);
			if (!intent.valid || this.closed) return;
			const submitted = await inspectNativeChildIdentity(this.harness, this.target.durableSessionId, request, this.context);
			const { valid: _valid, phase: _phase, ...proof } = intent.proof;
			const base = { ...proof, parentThreadId: this.target.parentThreadId };
			const key = `${candidate.taskId}:${candidate.childConversationId}`;
			if (!this.seen.has(key)) {
				const discovery = NativeChildDiscoverySchema.parse({ ...base, phase: "intent" });
				await this.emit(discovery);
				if (this.closed) return;
				this.seen.set(key, "intent");
			}
			if (submitted.valid && this.seen.get(key) !== "submitted") {
				const discovery = NativeChildDiscoverySchema.parse({ ...base, phase: "submitted" });
				await this.emit(discovery);
				if (!this.closed) this.seen.set(key, "submitted");
			}
		}).catch(this.onError);
	}

	private onCommit(publication: CommitPublication): void {
		if (this.closed) return;
		const candidates = new Map<ConversationId, Candidate>();
		for (const change of publication.changes) {
			if (change.type === "conversation" && change.value.owner?.conversationId === this.target.parentConversationId) {
				candidates.set(change.value.id, { childConversationId: change.value.id, taskId: change.value.owner.taskId });
			}
			if (change.type === "submission" && change.value.requestId?.startsWith("subagent:")) {
				const taskId = Number(change.value.requestId.slice("subagent:".length));
				if (Number.isSafeInteger(taskId) && taskId >= 0) {
					candidates.set(change.value.conversationId, { childConversationId: change.value.conversationId, taskId: taskId as TaskId });
				}
			}
		}
		for (const candidate of candidates.values()) this.enqueue(candidate);
	}

	/** One-shot restore over existing and terminal task-owned conversations; no timer or executor. */
	async reconcile(): Promise<NativeChildDiscovery[]> {
		if (this.closed || this.target.parentConversationId !== ROOT_CONVERSATION_ID) return [];
		const found: Candidate[] = [];
		let cursor: Cursor | undefined;
		// The SDK owns the opaque cursor; each bounded page remains a read-only transaction.
		for (;;) {
			const page = await this.harness.commit((tx) => tx.scanConversations({ ownerConversationId: this.target.parentConversationId }, 128, cursor), this.context);
			for (const conversation of page.items) {
				if (conversation.owner?.conversationId === this.target.parentConversationId) found.push({ childConversationId: conversation.id, taskId: conversation.owner.taskId });
			}
			if (!page.next) break;
			cursor = page.next;
		}
		const result: NativeChildDiscovery[] = [];
		for (const candidate of found) {
			const request = { ...this.target, ...candidate };
			const intent = await inspectNativeChildIntent(this.harness, this.target.durableSessionId, request, this.context);
			if (!intent.valid) continue;
			const submitted = await inspectNativeChildIdentity(this.harness, this.target.durableSessionId, request, this.context);
			const { valid: _valid, phase: _phase, ...proof } = intent.proof;
			result.push(NativeChildDiscoverySchema.parse({ ...proof, parentThreadId: this.target.parentThreadId, phase: submitted.valid ? "submitted" : "intent" }));
		}
		return result;
	}

	async idle(): Promise<void> { await this.pending; }
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
		this.unsubscribeClose();
	}
}
