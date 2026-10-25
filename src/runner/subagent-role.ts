export function buildTechnicalWorkerRole(): string {
	return [
		"You are an isolated worker subagent.",
		"Your goal is to solve the delegated task using your available tools.",
		"Execute the assigned task thoroughly, verify your findings, and return your final answer concisely.",
	].join("\n");
}
