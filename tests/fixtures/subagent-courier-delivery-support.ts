import { createSubagentExtension } from "durable-zero/core";

const Subagent = createSubagentExtension(() => ({
	version: 1,
	revision: 0,
	policy: { mode: "inherit" },
}));
export { Subagent };
