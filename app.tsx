import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SubagentSettingsSection } from "./src/ui/settings-subagent-section.tsx";
import {
	RuntimeGraphSummary,
	RuntimeGraphSegmentDetails,
	useRuntimeGraphVisible,
} from "./src/ui/runtime-graph/index.ts";

export default definePluginApp((app) => {
	app.slots.settingsSection({
		id: "subagent-model-policy",
		title: "Subagents",
		component: SubagentSettingsSection,
	});

	app.slots.experimental_threadContextSegment({
		id: "runtime-graph",
		title: "Task graph",
		group: "2_runtime",
		summary: RuntimeGraphSummary,
		details: RuntimeGraphSegmentDetails,
		useVisible: useRuntimeGraphVisible,
	});
});
