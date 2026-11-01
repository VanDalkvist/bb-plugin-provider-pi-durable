import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createDurableController, type ControllerContext } from "../src/runner/runtime-controller.ts";
import { runtimeContext } from "../src/runner/runtime-types.ts";
import { hydrateSessionActiveTools } from "../src/runner/runtime.ts";

describe("Active Tool Loadout & Controller Parity (Cycle 98 - AP-010, AP-020)", () => {
	it("submit passes current active tools and reconciles handler-edited selectedTools", async () => {
		let configuredModelTools: string[] | undefined;
		let beforeStartPassedTools: string[] | undefined;

		const mockAgent = {
			tools: [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }],
		};

		const mockConversation = {
			agent: async () => mockAgent,
			configure: async (change: any) => {
				if (change.modelTools) configuredModelTools = change.modelTools;
			},
			submit: async () => ({
				wait: async () => ({ status: "done", type: "input" }),
			}),
		};

		const mockRunner: any = {
			getActiveTools: () => ["read", "bash", "edit", "write"],
			setActiveTools: () => {},
			emitBeforeAgentStart: async (_trigger: any, options: any) => {
				beforeStartPassedTools = options.selectedTools;
				return {
					systemPromptOptions: {
						selectedTools: ["read", "edit"], // Hook explicitly narrows tools
					},
				};
			},
			emit: async () => ({}),
		};

		const ctx: ControllerContext = {
			bindings: {
				current: mockConversation as any,
				tasksOpen: false,
				bindConversation: () => {},
				attachTasks: () => {},
				closeTasks: () => {},
			},
			opened: {} as any,
			modelRuntime: {
				getModel: () => ({ provider: "test", id: "m1" }),
				getAvailableSnapshot: () => [],
			} as any,
			getState: () => ({
				conversation: { docs: { "pi.agent": { model: { provider: "test", modelId: "m1" } } } } as any,
				session: {} as any,
				conversations: [],
				models: [],
				notices: [],
			}),
			notice: () => {},
			fail: (err) => { throw err; },
			setActiveModelRef: () => {},
			extensionRunner: mockRunner,
		};

		const controller = createDurableController(ctx);
		await controller.submit("test prompt", "followUp");

		// 1. Initial tools were passed to emitBeforeAgentStart
		assert.deepEqual(beforeStartPassedTools, ["read", "bash", "edit", "write"]);

		// 2. Hook-edited selectedTools was applied to conversation.configure({ modelTools })
		assert.deepEqual(configuredModelTools, [{ name: "read" }, { name: "edit" }]);
	});

	it("submit applies setActiveTools when hook does not edit selectedTools directly", async () => {
		let configuredModelTools: string[] | undefined;
		let currentActive = ["read", "bash", "edit", "write"];

		const mockAgent = {
			tools: [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }],
		};

		const mockConversation = {
			agent: async () => mockAgent,
			configure: async (change: any) => {
				if (change.modelTools) configuredModelTools = change.modelTools;
			},
			submit: async () => ({
				wait: async () => ({ status: "done", type: "input" }),
			}),
		};

		const mockRunner: any = {
			getActiveTools: () => currentActive,
			setActiveTools: (tools: string[]) => { currentActive = tools; },
			emitBeforeAgentStart: async () => {
				// Handler called pi.setActiveTools instead of mutating systemPromptOptions
				currentActive = ["read", "write"];
				return {
					systemPromptOptions: {
						selectedTools: ["read", "bash", "edit", "write"], // untouched
					},
				};
			},
			emit: async () => ({}),
		};

		const ctx: ControllerContext = {
			bindings: {
				current: mockConversation as any,
				tasksOpen: false,
				bindConversation: () => {},
				attachTasks: () => {},
				closeTasks: () => {},
			},
			opened: {} as any,
			modelRuntime: {
				getModel: () => ({ provider: "test", id: "m1" }),
				getAvailableSnapshot: () => [],
			} as any,
			getState: () => ({
				conversation: { docs: { "pi.agent": { model: { provider: "test", modelId: "m1" } } } } as any,
				session: {} as any,
				conversations: [],
				models: [],
				notices: [],
			}),
			notice: () => {},
			fail: (err) => { throw err; },
			setActiveModelRef: () => {},
			extensionRunner: mockRunner,
		};

		const controller = createDurableController(ctx);
		await controller.submit("test prompt", "followUp");

		// setActiveTools list was applied to conversation.configure({ modelTools })
		assert.deepEqual(configuredModelTools, [{ name: "read" }, { name: "write" }]);
	});

	it("hydrateSessionActiveTools restores persisted tools including empty array and ignores undefined", () => {
		let restored: string[] | undefined;
		const envState = { setActiveTools: (tools: string[]) => { restored = tools; } };

		hydrateSessionActiveTools({ tools: [{ name: "read" }, { name: "edit" }] }, envState);
		assert.deepEqual(restored, ["read", "edit"]);

		// P3 guard: explicitly configured empty tools must NOT be ignored
		restored = ["read"];
		hydrateSessionActiveTools({ tools: [] }, envState);
		assert.deepEqual(restored, []);

		// undefined tools (legacy session) leaves state untouched
		restored = ["read"];
		hydrateSessionActiveTools({}, envState);
		assert.deepEqual(restored, ["read"]);
	});

	it("reopen / resume round-trip with real Harness and MemoryStorage hydrates active tools", async () => {
		const readTool = defineTool({
			name: "read",
			description: "Read",
			parameters: Type.Object({ path: Type.String() }),
			callers: ["model", "tools"],
			execute: async () => ({ output: [] }),
		});
		const editTool = defineTool({
			name: "edit",
			description: "Edit",
			parameters: Type.Object({ path: Type.String() }),
			callers: ["model", "tools"],
			execute: async () => ({ output: [] }),
		});
		const ext = defineExtension({ name: "core", tools: [readTool, editTool] });

		const registry = createRegistry();
		registry.install(ext);

		const storage = new MemoryStorage();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);

		const root = await harness.root(BACKGROUND_CONTEXT, {
			agent: {
				model: { provider: "faux", modelId: "faux-1" },
				modelTools: [{ name: "read" }, { name: "edit" }] as any,
			},
		});

		// Verify persisted state in AgentDoc
		const rootAgent = await root.agent(BACKGROUND_CONTEXT);
		assert.deepEqual(rootAgent.tools?.map((t) => t.name), ["read", "edit"]);

		// Reopen root conversation (analogous to !location.created in runtime.ts)
		const reopened = await harness.root(BACKGROUND_CONTEXT);
		const reopenedAgent = await reopened.agent(BACKGROUND_CONTEXT);

		let hydratedTools: string[] = ["read", "bash", "edit", "write"];
		const activeEnvState = {
			setActiveTools: (tools: string[]) => { hydratedTools = tools; },
		};

		hydrateSessionActiveTools(reopenedAgent, activeEnvState);
		assert.deepEqual(hydratedTools, ["read", "edit"]);
	});
});
