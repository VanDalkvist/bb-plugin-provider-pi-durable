import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDurableController, type ControllerContext } from "../src/runner/runtime-controller.ts";

function injectedController() {
	const notices: unknown[] = [];
	const applied = { model: { provider: "injected", modelId: "old" }, thinkingLevel: "low" };
	let activeRef = { ...applied.model };
	let rejectConfig = false;
	let rejectSubmit = false;
	let rejectAbort = false;
	let answerWaited = false;
	let submissionCount = 0;
	const configured: Array<{ model?: { provider: string; modelId: string }; thinkingLevel?: string }> = [];
	const conversation = {
		configure: async (config: { model?: { provider: string; modelId: string }; thinkingLevel?: string }) => {
			if (rejectConfig) throw new Error("native configure rejected");
			configured.push(config);
			if (config.model) applied.model = config.model;
			if (config.thinkingLevel) applied.thinkingLevel = config.thinkingLevel;
		},
		submit: async () => {
			if (rejectSubmit) throw new Error("native submission rejected");
			submissionCount++;
			return { wait: () => { answerWaited = true; return new Promise(() => {}); } };
		},
		abort: async () => { if (rejectAbort) throw new Error("native abort rejected"); },
	};
	const ctx = {
		getCurrent: () => conversation,
		getState: () => ({ conversation: { docs: { "pi.agent": applied } } }),
		modelRuntime: { getModel: (_provider: string, modelId: string) => modelId === "unknown" ? undefined : { reasoning: true } },
		setActiveModelRef: (model: typeof activeRef) => { activeRef = { ...model }; },
		fail: (error: unknown) => { notices.push(error); },
		notice: () => {},
	} as unknown as ControllerContext;
	return {
		controller: createDurableController(ctx),
		applied, configured, notices,
		get activeRef() { return activeRef; },
		get answerWaited() { return answerWaited; },
		get submissionCount() { return submissionCount; },
		set rejectConfig(value: boolean) { rejectConfig = value; },
		set rejectSubmit(value: boolean) { rejectSubmit = value; },
		set rejectAbort(value: boolean) { rejectAbort = value; },
	};
}

describe("Durable controller truthful queued operations", () => {
	it("rejects failed native model configure without poisoning applied model or queue", async () => {
		const state = injectedController();
		state.rejectConfig = true;
		await assert.rejects(state.controller.setModel({ provider: "injected", modelId: "new" }), /native configure rejected/);
		assert.deepEqual(state.activeRef, { provider: "injected", modelId: "old" });
		assert.deepEqual(state.applied.model, { provider: "injected", modelId: "old" });
		assert.equal(state.notices.length, 1);
		state.rejectConfig = false;
		await state.controller.setModel({ provider: "injected", modelId: "new" });
		assert.deepEqual(state.activeRef, { provider: "injected", modelId: "new" });
		assert.deepEqual(state.applied.model, state.activeRef);
	});

	it("rejects failed native thinking configure, retains applied state, then accepts a valid queued setting", async () => {
		const state = injectedController();
		state.rejectConfig = true;
		await assert.rejects(state.controller.setThinkingLevel("high"), /native configure rejected/);
		assert.equal(state.applied.thinkingLevel, "low");
		assert.deepEqual(state.activeRef, { provider: "injected", modelId: "old" });
		state.rejectConfig = false;
		await state.controller.setThinkingLevel("high");
		assert.equal(state.applied.thinkingLevel, "high");
		assert.equal(state.configured.length, 1);
	});

	it("returns failed submit/abort errors without blocking a later native submission; answer wait remains detached", async () => {
		const state = injectedController();
		state.rejectSubmit = true;
		await assert.rejects(state.controller.submit("first", "followUp"), /native submission rejected/);
		state.rejectAbort = true;
		await assert.rejects(state.controller.abort(), /native abort rejected/);
		state.rejectAbort = false;
		state.rejectSubmit = false;
		await state.controller.submit("accepted", "followUp");
		assert.equal(state.submissionCount, 1);
		assert.equal(state.answerWaited, true, "answer wait is detached from native acceptance");
		assert.equal(state.notices.length, 2);
	});
});
