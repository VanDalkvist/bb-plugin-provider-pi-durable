import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileSessionOptions } from "../src/host/session-reconcile.ts";
import { resolvePiNativeRoots } from "../src/host/native-roots.ts";
import { parseCliArgs } from "../src/runner/cli-args.ts";
import { buildRunnerArgs } from "../src/host/session-telemetry.ts";
import { setupExtensionRunner } from "../src/runner/extension-bridge.ts";
import { ModelCatalog } from "../src/host/catalog.ts";
import { DefaultResourceLoader, getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

describe("Cycle 102 Stubs Remediation Suite", () => {
	it("reconcileSessionOptions switches model and thinking level mid-session", async () => {
		let updatedModel: { provider: string; modelId: string } | undefined;
		let updatedThinking: string | undefined;

		const mockSession = {
			options: {
				model: { provider: "anthropic", id: "claude-3-7-sonnet" },
				thinkingLevel: "low",
			},
			setModel: async (provider: string, modelId: string) => {
				updatedModel = { provider, modelId };
				mockSession.options.model = { provider, id: modelId };
			},
			setThinkingLevel: async (level: string) => {
				updatedThinking = level;
				mockSession.options.thinkingLevel = level;
			},
		};

		// 1. Turn start with same model & thinking -> no calls
		await reconcileSessionOptions(mockSession, {
			model: "anthropic/claude-3-7-sonnet",
			reasoningLevel: "low",
		});
		assert.equal(updatedModel, undefined, "should not call setModel when model is unchanged");
		assert.equal(updatedThinking, undefined, "should not call setThinkingLevel when level is unchanged");

		// 2. Turn start with new model and new thinking level
		await reconcileSessionOptions(mockSession, {
			model: "antigravity/gemini-3.8-flash",
			reasoningLevel: "high",
		});

		assert.deepEqual(updatedModel, { provider: "antigravity", modelId: "gemini-3.8-flash" });
		assert.equal(updatedThinking, "high");
	});

	it("parseCliArgs parses multiple --skill flags into args.skills array", () => {
		const parsed = parseCliArgs([
			"--mode", "rpc",
			"--skill", "/workspace/skills/alpha",
			"--session", "/tmp/session",
			"--skill", "/workspace/skills/beta",
		]);

		assert.deepEqual(parsed.skills, [
			"/workspace/skills/alpha",
			"/workspace/skills/beta",
		]);
	});

	it("buildRunnerArgs appends --skill flags for each additionalSkillPath", () => {
		const args = buildRunnerArgs({
			threadId: "thr_1",
			providerThreadId: "pi_1",
			sessionFilePath: "/tmp/session",
			sessionDir: "/tmp",
			extensionPath: "/tmp/ext.mjs",
			scratchDir: "/tmp/scratch",
			additionalSkillPaths: ["/skills/one", "/skills/two"],
		});

		assert.ok(args.includes("--skill"), "args must include --skill");
		const skillIndices = args.map((a, i) => a === "--skill" ? i : -1).filter((i) => i !== -1);
		assert.equal(skillIndices.length, 2, "must have 2 --skill flags");
		assert.equal(args[skillIndices[0] + 1], "/skills/one");
		assert.equal(args[skillIndices[1] + 1], "/skills/two");
	});

	it("resolvePiNativeRoots discovers real native skill directories with user origin", () => {
		const res = resolvePiNativeRoots();
		assert.ok(Array.isArray(res.skills), "skills must be an array");
		for (const root of res.skills) {
			assert.equal(root.origin, "user");
			assert.equal(root.recursive, true);
			assert.equal(root.shape, "skills");
			assert.ok(typeof root.path === "string" && root.path.length > 0);
		}
	});

	it("setupExtensionRunner binds context actions to real hooks", async () => {
		const modelRuntime = await ModelRuntime.create();
		let abortCalled = false;
		let compactInstructions: string | undefined;

		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			settingsManager: SettingsManager.create(process.cwd()),
		});
		await loader.reload();
		const { runtime } = loader.getExtensions();

		const runner = await setupExtensionRunner({
			extensions: [],
			runtime,
			cwd: process.cwd(),
			modelRuntime,
			executeToolFn: async () => ({
				toolCall: { type: "toolCall", id: "test", name: "test", arguments: {} },
				result: { content: [], details: {} },
				isError: false,
			}),
			onAbort: () => { abortCalled = true; },
			onCompact: (i) => { compactInstructions = i; },
			getContextUsage: () => ({ tokens: 1234, contextWindow: 200000 }),
			isIdle: () => false,
		});

		const ctx = (runner as any).createContext();
		assert.equal(ctx.isIdle(), false);

		ctx.abort();
		assert.equal(abortCalled, true);

		ctx.compact("custom summary");
		assert.equal(compactInstructions, "custom summary");

		const usage = ctx.getContextUsage();
		assert.deepEqual(usage, { tokens: 1234, contextWindow: 200000, percent: 0.617 });
	});

	it("ModelCatalog.listModels maps dynamic reasoning efforts based on model reasoning capabilities", async () => {
		const catalog = new ModelCatalog({ defaultModelId: "anthropic/claude-3-7-sonnet" });
		(catalog as any).runner = {
			exited: false,
			requestOk: async () => ({
				models: [
					{
						provider: "anthropic",
						id: "claude-3-7-sonnet",
						name: "Claude 3.7 Sonnet",
						reasoning: true,
						defaultReasoningEffort: "medium",
						thinkingLevelMap: { off: "off", low: 1000, medium: 2000, high: 4000 },
					},
					{
						provider: "anthropic",
						id: "claude-3-haiku",
						name: "Claude 3 Haiku",
						reasoning: false,
					},
				],
			}),
		};

		const list = await catalog.listModels();
		assert.equal(list.length, 2);

		const sonnet = list.find((m) => m.id === "anthropic/claude-3-7-sonnet")!;
		assert.ok(sonnet);
		assert.equal(sonnet.defaultReasoningEffort, "medium");
		assert.deepEqual(
			sonnet.supportedReasoningEfforts.map((r) => r.reasoningEffort),
			["none", "low", "medium", "high"],
		);

		const haiku = list.find((m) => m.id === "anthropic/claude-3-haiku")!;
		assert.ok(haiku);
		assert.equal(haiku.defaultReasoningEffort, "none");
		assert.deepEqual(haiku.supportedReasoningEfforts, []);
	});

	it("reconcileSessionOptions handles object model with modelId and reasoningLevel: none", async () => {
		let updatedModel: { provider: string; modelId: string } | undefined;
		let updatedThinking: string | undefined;

		const mockSession = {
			options: {
				model: { provider: "antigravity", id: "gemini-3.8-flash" },
				thinkingLevel: "high",
			},
			setModel: async (provider: string, modelId: string) => {
				updatedModel = { provider, modelId };
				mockSession.options.model = { provider, id: modelId };
			},
			setThinkingLevel: async (level: string) => {
				updatedThinking = level;
				mockSession.options.thinkingLevel = level;
			},
		};

		await reconcileSessionOptions(mockSession, {
			model: { provider: "anthropic", modelId: "claude-3-haiku" },
			reasoningLevel: "none",
		});

		assert.deepEqual(updatedModel, { provider: "anthropic", modelId: "claude-3-haiku" });
		assert.equal(updatedThinking, "none");
	});
});
