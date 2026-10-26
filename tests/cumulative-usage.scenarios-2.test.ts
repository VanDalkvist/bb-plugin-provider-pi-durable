import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { DurableView } from "../src/runner/runtime-types.ts";
import { extractCumulativeUsage } from "../src/runner/bridge/assistant-message-builder.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import { translateAgentEndUsage } from "../src/host/message-delta-translator.ts";
import type { BBWireEvent, CumulativeUsageMetrics } from "../src/runner/bridge/contracts.ts";
import { jsonFixture, viewFixture } from "./fixtures/durable.ts";
import { createMockView } from "./fixtures/cumulative-usage-support.ts";

describe("Cumulative Token Usage Monotonicity & pi.usage Sync (Cycle 70, D-7)", () => {
    it("monotonicity: delta.total.totalTokens grows strictly across multiple turns", () => {
        const turn1Msg = { usage: { input: 100, output: 50, totalTokens: 150 } };
        const cumTurn1: CumulativeUsageMetrics = { totalTokens: 150, inputTokens: 100, outputTokens: 50 };
        const deltasTurn1 = translateAgentEndUsage(turn1Msg, 128000, cumTurn1);
        const usageTurn1 = deltasTurn1.find((d) => d.kind === "usage")!;
        const total1 = (usageTurn1.total as {
            totalTokens: number;
        }).totalTokens;
        const last1 = (usageTurn1.last as {
            totalTokens: number;
        }).totalTokens;
        assert.equal(last1, 150);
        assert.equal(total1, 150);
        const turn2Msg = { usage: { input: 120, output: 60, totalTokens: 180 } };
        const cumTurn2: CumulativeUsageMetrics = { totalTokens: 330, inputTokens: 220, outputTokens: 110 };
        const deltasTurn2 = translateAgentEndUsage(turn2Msg, 128000, cumTurn2);
        const usageTurn2 = deltasTurn2.find((d) => d.kind === "usage")!;
        const total2 = (usageTurn2.total as {
            totalTokens: number;
        }).totalTokens;
        const last2 = (usageTurn2.last as {
            totalTokens: number;
        }).totalTokens;
        assert.equal(last2, 180);
        assert.equal(total2, 330);
        assert.ok(total2 > total1, "totalTokens must monotonically grow on Turn 2");
        const turn3Msg = { usage: { input: 50, output: 25, totalTokens: 75 } };
        const cumTurn3: CumulativeUsageMetrics = { totalTokens: 405, inputTokens: 270, outputTokens: 135 };
        const deltasTurn3 = translateAgentEndUsage(turn3Msg, 128000, cumTurn3);
        const usageTurn3 = deltasTurn3.find((d) => d.kind === "usage")!;
        const total3 = (usageTurn3.total as {
            totalTokens: number;
        }).totalTokens;
        const last3 = (usageTurn3.last as {
            totalTokens: number;
        }).totalTokens;
        assert.equal(last3, 75);
        assert.equal(total3, 405);
        assert.ok(total3 > total2, "totalTokens must monotonically grow on Turn 3");
        assert.notEqual(last3, total3, "Turn 3 spend must not overwrite thread total spend");
    });
});
