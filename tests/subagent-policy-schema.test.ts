import test from "node:test";
import assert from "node:assert/strict";
import {
  subagentPolicyRecordSchema,
  subagentPolicySchema,
  subagentPolicySetInputSchema,
  subagentThinkingLevelSchema,
  subagentModelReferenceSchema,
  subagentModelProfileSchema,
} from "../src/policy/schema.ts";

test("subagentPolicySchema: validates inherit mode with or without configuredProfile", () => {
  const minimalInherit = { mode: "inherit" };
  assert.deepEqual(subagentPolicySchema.parse(minimalInherit), minimalInherit);

  const inheritWithProfile = {
    mode: "inherit",
    configuredProfile: {
      model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
      thinkingLevel: "high",
    },
  };
  assert.deepEqual(subagentPolicySchema.parse(inheritWithProfile), inheritWithProfile);
});

test("subagentPolicySchema: validates configured mode with mandatory configuredProfile", () => {
  const configured = {
    mode: "configured",
    configuredProfile: {
      model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
      thinkingLevel: "medium",
    },
  };
  assert.deepEqual(subagentPolicySchema.parse(configured), configured);

  // Missing configuredProfile should throw
  assert.throws(
    () => subagentPolicySchema.parse({ mode: "configured" }),
    /configuredProfile/
  );
});

test("subagentPolicySchema: rejects unknown keys due to strict validation", () => {
  assert.throws(
    () => subagentPolicySchema.parse({ mode: "inherit", extra: true }),
    /unrecognized_keys/i
  );
});

test("subagentThinkingLevelSchema: accepts valid thinking levels and rejects invalid", () => {
  const valid = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  for (const level of valid) {
    assert.equal(subagentThinkingLevelSchema.parse(level), level);
  }

  assert.throws(() => subagentThinkingLevelSchema.parse("none"));
  assert.throws(() => subagentThinkingLevelSchema.parse("invalid"));
});

test("subagentPolicyRecordSchema: validates canonical record shape and strict bounds", () => {
  const validRecord = {
    version: 1,
    revision: 0,
    policy: { mode: "inherit" },
  };
  assert.deepEqual(subagentPolicyRecordSchema.parse(validRecord), validRecord);

  const recordWithTimestamp = {
    version: 1,
    revision: 4,
    updatedAt: "2026-10-25T12:00:00.000Z",
    policy: {
      mode: "configured",
      configuredProfile: {
        model: { provider: "google", modelId: "gemini-2.5-pro" },
        thinkingLevel: "off",
      },
    },
  };
  assert.deepEqual(subagentPolicyRecordSchema.parse(recordWithTimestamp), recordWithTimestamp);

  // Rejects invalid version
  assert.throws(() => subagentPolicyRecordSchema.parse({ ...validRecord, version: 2 }));
  // Rejects negative revision
  assert.throws(() => subagentPolicyRecordSchema.parse({ ...validRecord, revision: -1 }));
  // Rejects floating revision
  assert.throws(() => subagentPolicyRecordSchema.parse({ ...validRecord, revision: 1.5 }));
});

test("subagentPolicySetInputSchema: validates set input with expectedRevision and strict shape", () => {
  const validInput = {
    policy: { mode: "inherit" },
    expectedRevision: 0,
  };
  assert.deepEqual(subagentPolicySetInputSchema.parse(validInput), validInput);

  assert.throws(() =>
    subagentPolicySetInputSchema.parse({ policy: { mode: "inherit" }, expectedRevision: -1 })
  );
  assert.throws(() =>
    subagentPolicySetInputSchema.parse({ policy: { mode: "inherit" } })
  );
});
