import { createSubagentExtension } from "../../src/runner/subagent.ts";

const Subagent = createSubagentExtension(() => ({
	version: 1,
	revision: 0,
	policy: { mode: "inherit" },
}));
export { Subagent };
