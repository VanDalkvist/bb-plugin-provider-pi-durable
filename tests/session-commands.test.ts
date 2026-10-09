import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { handleActiveSessionCommand } from "../src/runner/session-commands.ts";
import { parseCliArgs } from "../src/runner/cli-args.ts";

type SessionDurable = Parameters<typeof handleActiveSessionCommand>[1];
type SessionModels = Parameters<typeof handleActiveSessionCommand>[2];

const models = { getAvailableSnapshot: () => [], getModel: () => undefined } as unknown as SessionModels;
const args = parseCliArgs([]);

function fakeDurable(controller: Record<string, unknown>): SessionDurable {
	return {
		harness: {} as SessionDurable["harness"],
		view: { current: () => ({ session: { id: "injected", directory: "/memory", cwd: "/memory" },
			conversation: { conversation: { id: ROOT_CONVERSATION_ID }, docs: { "pi.agent": { thinkingLevel: "low" } } } as ReturnType<SessionDurable["view"]["current"]>["conversation"] }) },
		controller: controller as SessionDurable["controller"],
	};
}

describe("retained native root command acknowledgements", () => {
	it("does not ACK or unlock after failed first submit, denies abort/compact and accepts a later retry", async () => {
		const events: string[] = [];
		const state = { executionStarted: false };
		let attempts = 0;
		const durable = fakeDurable({
			submit: async (_message: string, behavior: string) => {
				events.push(`submit:${behavior}`);
				if (++attempts === 1) throw new Error("submission unavailable");
			},
			abort: async () => { events.push("abort-called"); },
			compact: async () => { events.push("compact-called"); },
			setModel: async () => {}, setThinkingLevel: async () => {},
		});
		const responder = { success: (_id: string | undefined, command: string) => { events.push(`success:${command}`); },
			error: (_id: string | undefined, command: string) => { events.push(`error:${command}`); } };
		const run = async (command: Record<string, unknown>) => {
			try { await handleActiveSessionCommand(command, durable, models, args, responder, undefined, state); }
			catch { responder.error(undefined, command.type as string); }
		};
		await run({ type: "prompt", id: "first", message: "first" });
		assert.equal(state.executionStarted, false);
		assert.deepEqual(events, ["submit:followUp", "error:prompt"]);
		await run({ type: "abort" });
		await run({ type: "compact" });
		assert.deepEqual(events.slice(2), ["error:abort", "error:compact"], "failed submission cannot wake restored tasks");
		await run({ type: "steer", id: "retry", message: "second" });
		assert.equal(state.executionStarted, true);
		assert.deepEqual(events.slice(4, 6), ["submit:steer", "success:steer"]);
		await run({ type: "abort" });
		assert.equal(events.at(-1), "success:abort");
		assert.equal(events.at(-2), "abort-called");
	});

	it("does not acknowledge rejected model/thinking changes and processes a later valid command", async () => {
		const replies: string[] = [];
		let reject = true;
		const applied = { model: "old", thinking: "low" };
		const durable = fakeDurable({ submit: async () => {}, abort: async () => {}, compact: async () => {},
			setModel: async ({ modelId }: { modelId: string }) => {
				if (reject) throw new Error("model configure rejected");
				applied.model = modelId;
			},
			setThinkingLevel: async (level: string) => {
				if (reject) throw new Error("thinking configure rejected");
				applied.thinking = level;
			},
		});
		const responder = { success: (_id: string | undefined, command: string) => { replies.push(`success:${command}`); },
			error: (_id: string | undefined, command: string) => { replies.push(`error:${command}`); } };
		const run = async (cmd: Record<string, unknown>) => {
			try { await handleActiveSessionCommand(cmd, durable, models, args, responder); }
			catch { responder.error(undefined, cmd.type as string); }
		};
		await run({ type: "set_model", provider: "injected", modelId: "new" });
		await run({ type: "set_thinking_level", level: "high" });
		assert.deepEqual(replies, ["error:set_model", "error:set_thinking_level"]);
		assert.deepEqual(applied, { model: "old", thinking: "low" });
		reject = false;
		await run({ type: "set_model", provider: "injected", modelId: "new" });
		await run({ type: "set_thinking_level", level: "high" });
		assert.deepEqual(replies.slice(2), ["success:set_model", "success:set_thinking_level"]);
		assert.deepEqual(applied, { model: "new", thinking: "high" });
	});

	it("waits for submission acceptance, not answer completion, before acknowledging prompt", async () => {
		let accept: (() => void) | undefined;
		const acceptance = new Promise<void>((resolve) => { accept = resolve; });
		const events: string[] = [];
		const state = { executionStarted: false };
		const durable = fakeDurable({ submit: () => acceptance, abort: async () => {}, compact: async () => {}, setModel: async () => {}, setThinkingLevel: async () => {} });
		const pending = handleActiveSessionCommand({ type: "prompt", message: "accepted" }, durable, models, args,
			{ success: (_id, command) => { events.push(command); }, error: () => { throw new Error("unexpected error"); } }, undefined, state);
		await Promise.resolve();
		assert.equal(state.executionStarted, false);
		assert.deepEqual(events, []);
		accept?.();
		await pending;
		assert.equal(state.executionStarted, true);
		assert.deepEqual(events, ["prompt"]);
	});
});
