export interface MirrorSnapshot {
 readonly task: string;
 readonly status: "running" | "completed";
 readonly initialTurnConsumed?: boolean;
}
export interface MirrorAdoptionPort {
 markConsumed(): void;
 register(): boolean;
 output(): string;
 consumeCompleted(): void;
}
export type MirrorAdoption = { kind: "ordinary" } | { kind: "running" } | { kind: "completed"; terminalEmitted: boolean; outputText: string };

export function decideMirrorAdoption(state: MirrorSnapshot | undefined, text: string): "ordinary" | "running" | "completed" {
	if (!state || state.initialTurnConsumed || !state.task.trim()) return "ordinary";
	const task = state.task.trim(), input = text.trim();
	if (!(task === input || task.startsWith(input) || input.startsWith(task))) return "ordinary";
	return state.status;
}

export function adoptInitialMirror(state: MirrorSnapshot | undefined, text: string, port: MirrorAdoptionPort): MirrorAdoption {
	const kind = decideMirrorAdoption(state, text);
	if (kind === "ordinary") return { kind };
	port.markConsumed();
	const terminalEmitted = port.register();
	if (kind === "running") return { kind };
	const outputText = port.output();
	port.consumeCompleted();
	return { kind, terminalEmitted, outputText };
}
