import type { Conversation, ConversationView, TaskGraph } from "@earendil-works/pi-durable";
import type { DurableView, RuntimeBindingPort, RuntimeReadBinding } from "./runtime-types.ts";

/** Owns read subscriptions, not Durable execution or task state. */
export class RuntimeBindings implements RuntimeBindingPort {
	private conversation: Conversation;
	private view: RuntimeReadBinding<ConversationView>;
	private unsubscribe: () => void;
	private tasks?: RuntimeReadBinding<TaskGraph>;
	private unsubscribeTasks?: () => void;
	private epoch = 0;
	private taskEpoch = 0;
	private closed = false;
	private readonly update: (patch: Partial<DurableView>) => void;

	constructor(conversation: Conversation, view: RuntimeReadBinding<ConversationView>, update: (patch: Partial<DurableView>) => void) {
		this.conversation = conversation;
		this.view = view;
		this.update = update;
		try {
			this.unsubscribe = view.subscribe((value) => {
				if (!this.closed && this.epoch === 0) this.update({ conversation: value });
			});
		} catch (cause) {
			try { view.dispose(); } catch (cleanup) { throw new AggregateError([cause, cleanup], "SUBSCRIBE_FAILED"); }
			throw new Error("SUBSCRIBE_FAILED", { cause });
		}
	}

	get current(): Conversation { return this.conversation; }
	get tasksOpen(): boolean { return this.tasks !== undefined; }

	bindConversation(conversation: Conversation, view: RuntimeReadBinding<ConversationView>): void {
		if (this.closed) { view.dispose(); throw new Error("BINDING_CLOSED"); }
		if (this.view === view) return;
		const epoch = this.epoch + 1;
		let unsubscribe: () => void;
		try {
			unsubscribe = view.subscribe((value) => {
				if (!this.closed && this.epoch === epoch) this.update({ conversation: value });
			});
		} catch (cause) {
			view.dispose();
			throw new Error("SUBSCRIBE_FAILED", { cause });
		}
		const previous = this.view, previousUnsubscribe = this.unsubscribe;
		this.view = view; this.conversation = conversation; this.unsubscribe = unsubscribe; this.epoch = epoch;
		try { previousUnsubscribe(); } finally { previous.dispose(); }
		this.update({ conversation: view.value });
	}

	attachTasks(view: RuntimeReadBinding<TaskGraph>): void {
		if (this.closed) { view.dispose(); throw new Error("BINDING_CLOSED"); }
		if (this.tasks === view) return;
		const epoch = this.taskEpoch + 1;
		let unsubscribe: () => void;
		try {
			unsubscribe = view.subscribe((value) => {
				if (!this.closed && this.taskEpoch === epoch) this.update({ tasks: value });
			});
		} catch (cause) {
			view.dispose();
			throw new Error("SUBSCRIBE_FAILED", { cause });
		}
		const previous = this.tasks, previousUnsubscribe = this.unsubscribeTasks;
		this.tasks = view; this.unsubscribeTasks = unsubscribe; this.taskEpoch = epoch;
		try { previousUnsubscribe?.(); } finally { previous?.dispose(); }
		this.update({ tasks: view.value });
	}

	closeTasks(): void {
		if (!this.tasks) return;
		this.taskEpoch++;
		const previous = this.tasks, unsubscribe = this.unsubscribeTasks;
		this.tasks = undefined; this.unsubscribeTasks = undefined;
		try { unsubscribe?.(); } finally { previous.dispose(); }
		if (!this.closed) this.update({ tasks: undefined });
	}

	close(): void {
		if (this.closed) return;
		this.closed = true; this.epoch++;
		try { this.unsubscribe(); }
		finally { try { this.view.dispose(); } finally { this.closeTasks(); } }
	}
}
