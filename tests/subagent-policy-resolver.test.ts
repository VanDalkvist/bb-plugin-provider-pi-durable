import test from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  resolveSubagentModelConfiguration,
  mapBbReasoningToNativeThinking,
  mapNativeThinkingToBbReasoning,
} from "../src/policy/resolver.ts";
import {
  SubagentModelUnavailableError,
  SubagentPolicyInvalidError,
} from "../src/policy/errors.ts";
import type { SubagentPolicyRecord } from "../src/policy/types.ts";

const mockModels: readonly Model<Api>[] = [
  {
    id: "claude-3-7-sonnet",
    name: "Claude 3.7 Sonnet",
    provider: "anthropic",
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
  } as unknown as Model<Api>,
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    api: "google-generative-ai",
    reasoning: false,
  } as unknown as Model<Api>,
];

test("resolveSubagentModelConfiguration: inherit mode resolves parent model and thinking", () => {
  const record: SubagentPolicyRecord = {
    version: 1,
    revision: 2,
    policy: { mode: "inherit" },
  };
  const resolved = resolveSubagentModelConfiguration(
    record,
    {
      model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
      thinkingLevel: "high",
    },
    mockModels
  );
  assert.deepEqual(resolved, {
    model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
    thinkingLevel: "high",
    source: "parent_inherited",
    policyRevision: 2,
  });
});

test("resolveSubagentModelConfiguration: inherit mode maps BB none to native off", () => {
  const record: SubagentPolicyRecord = {
    version: 1,
    revision: 1,
    policy: { mode: "inherit" },
  };
  const resolved = resolveSubagentModelConfiguration(
    record,
    {
      model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
      thinkingLevel: "none",
    },
    mockModels
  );
  assert.equal(resolved.thinkingLevel, "off");
});

test("resolveSubagentModelConfiguration: inherit mode fails fast when parent model missing", () => {
  const record: SubagentPolicyRecord = {
    version: 1,
    revision: 0,
    policy: { mode: "inherit" },
  };
  assert.throws(
    () => resolveSubagentModelConfiguration(record, {}, mockModels),
    (err: unknown) => {
      assert.ok(err instanceof SubagentPolicyInvalidError);
      assert.equal(err.code, "SUBAGENT_POLICY_INVALID");
      return true;
    }
  );
});

test("resolveSubagentModelConfiguration: configured mode matches model and checks thinking", () => {
  const record: SubagentPolicyRecord = {
    version: 1,
    revision: 5,
    policy: {
      mode: "configured",
      configuredProfile: {
        model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
        thinkingLevel: "medium",
      },
    },
  };
  const resolved = resolveSubagentModelConfiguration(record, {}, mockModels);
  assert.deepEqual(resolved, {
    model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
    thinkingLevel: "medium",
    source: "user_configured",
    policyRevision: 5,
  });
});

test("resolveSubagentModelConfiguration: fail-fast on unavailable configured model", () => {
  const record: SubagentPolicyRecord = {
    version: 1,
    revision: 1,
    policy: {
      mode: "configured",
      configuredProfile: {
        model: { provider: "openai", modelId: "gpt-4o" },
        thinkingLevel: "off",
      },
    },
  };
  assert.throws(
    () => resolveSubagentModelConfiguration(record, {}, mockModels),
    (err: unknown) => {
      assert.ok(err instanceof SubagentModelUnavailableError);
      assert.equal(err.code, "SUBAGENT_MODEL_UNAVAILABLE");
      assert.match(err.message, /Settings → Installed plugins → Pi Durable → Subagents/);
      return true;
    }
  );
});

test("resolveSubagentModelConfiguration: fails fast on unsupported thinking level", () => {
  const record: SubagentPolicyRecord = {
    version: 1,
    revision: 1,
    policy: {
      mode: "configured",
      configuredProfile: {
        model: { provider: "google", modelId: "gemini-2.5-flash" },
        thinkingLevel: "high", // flash reasoning is false -> only 'off' supported
      },
    },
  };
  assert.throws(
    () => resolveSubagentModelConfiguration(record, {}, mockModels),
    (err: unknown) => {
      assert.ok(err instanceof SubagentPolicyInvalidError);
      assert.equal(err.code, "SUBAGENT_POLICY_INVALID");
      assert.match(err.message, /Thinking level "high" is not supported/);
      return true;
    }
  );
});

test("boundary mapping: maps BB none <-> native off", () => {
  assert.equal(mapBbReasoningToNativeThinking("none"), "off");
  assert.equal(mapBbReasoningToNativeThinking("high"), "high");
  assert.equal(mapBbReasoningToNativeThinking(undefined), "off");

  assert.equal(mapNativeThinkingToBbReasoning("off"), "none");
  assert.equal(mapNativeThinkingToBbReasoning("high"), "high");
});
