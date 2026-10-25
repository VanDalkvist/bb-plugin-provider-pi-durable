import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SubagentSettingsSection } from "./src/ui/settings-subagent-section.tsx";

export default definePluginApp((app) => {
	app.slots.settingsSection({
		id: "subagent-model-policy",
		title: "Субагенты",
		component: SubagentSettingsSection,
	});
});
