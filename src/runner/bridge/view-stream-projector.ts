import type { RunnerEvent } from "./contracts.ts";

export interface ProjectedConversationState {
	readonly conversationId: string;
	readonly run?: { readonly id: string; readonly state: string } | null;
	readonly entries?: readonly unknown[];
}

export class ViewStreamProjector {
	private readonly sink: (event: RunnerEvent) => void;
	private activeRunId: string | null = null;

	constructor(sink: (event: RunnerEvent) => void) {
		this.sink = sink;
	}

	project(state: ProjectedConversationState): void {
		const run = state.run;
		if (run && run.state === "running" && this.activeRunId !== run.id) {
			this.activeRunId = run.id;
			this.sink({
				type: "agent_start",
				conversationId: state.conversationId,
			} as unknown as RunnerEvent);
			this.sink({
				type: "turn_start",
				conversationId: state.conversationId,
			} as unknown as RunnerEvent);
			return;
		}

		if (!run && this.activeRunId) {
			this.activeRunId = null;
			this.sink({
				type: "turn_end",
				conversationId: state.conversationId,
			} as unknown as RunnerEvent);
			this.sink({
				type: "agent_end",
				conversationId: state.conversationId,
			} as unknown as RunnerEvent);
		}
	}
}
