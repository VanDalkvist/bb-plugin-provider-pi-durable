export const SUPPORTED_EXTENSION_HOOKS = new Set([
	"session_start",
	"session_shutdown",
	"before_agent_start",
	"agent_end",
	"agent_settled",
	"session_before_compact",
	"session_compact",
	"tool_call",
	"tool_result",
]);
