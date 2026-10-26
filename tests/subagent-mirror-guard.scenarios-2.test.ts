import type { PromptRequest } from "../src/host/prompt-request.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleTurnStart, handleTurnSteer, type BridgeRouterContext } from "../src/host/bridge-router.ts";
import { buildSpawnArgs } from "../src/host/subthread-spawner.ts";
import { detectNativeChild } from "../src/host/session-owner.ts";
import { sessionFixture, registryFixture, contextFixture } from "./fixtures/mirror.ts";

describe("Subagent Mirror Guard & Root Isolation (Task 6)", () => {
    it("detectNativeChild identifies native composite conversation vs non-native child", () => {
        // 1. Native composite ID
        const native1 = detectNativeChild("child_1", "conv_99", undefined, undefined);
        assert.equal(native1.isNative, true);
        assert.equal(native1.conversationId, "conv_99");
        // 2. Native params.conversationId
        const native2 = detectNativeChild("child_2", undefined, "conv_100", undefined);
        assert.equal(native2.isNative, true);
        assert.equal(native2.conversationId, "conv_100");
        // 3. Non-native child: has parent, but no native binding
        const nonNative = detectNativeChild("manual_cli_child", undefined, undefined, "/nonexistent/session.sqlite");
        assert.equal(nonNative.isNative, false);
        assert.equal(nonNative.conversationId, undefined);
    });
});
