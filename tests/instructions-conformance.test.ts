import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("instructions-conformance: repo AGENTS.md documents role envelope, coordinator scoping, and policy-driven subagents", () => {
	const projectRoot = path.resolve(import.meta.dirname, "..");
	const repoAgentsContent = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");

	// 1. Documents Thin Adapter technical role envelope permissions
	assert.ok(
		repoAgentsContent.includes("subagent-role.ts") || repoAgentsContent.includes("worker envelope"),
		"AGENTS.md must document the technical role envelope contract",
	);

	// 2. Documents root coordinator vs task worker distinction
	assert.ok(
		repoAgentsContent.includes("координатор") && repoAgentsContent.includes("воркер"),
		"AGENTS.md must distinguish root coordinator from task worker",
	);

	// 3. Subagents governed by runtime policy, no LLM model kwargs / hardcoded models
	assert.ok(
		repoAgentsContent.includes("сохранённой политики") || repoAgentsContent.includes("runtime policy"),
		"AGENTS.md must specify that subagent model is derived from saved runtime policy",
	);
});
