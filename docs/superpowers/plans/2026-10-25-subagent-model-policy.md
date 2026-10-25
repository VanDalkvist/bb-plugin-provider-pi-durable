# Subagent Model Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Canonical location:** This repository file is the working execution plan, per the user's explicit correction on 2026-10-25. Thread-storage copies are drafts, not the source of truth.

**Execution baseline:** User approved implementation in `thr_3e4z9meeqs`. Repository `main`, HEAD `4d02d4c`, version `0.2.52`; 330 baseline tests and `npx tsc --noEmit` pass. Remote is PUBLIC: local commits are allowed, but this task does not authorize public push/tag/release. Installed BB0.47.1 / latest stable SDK0.6.79 confirmed. Task1 is approved after S7 correction below; Tasks2–10 require the critical-review amendments to be resolved before execution.

**Goal:** Implement centralized user subagent model policy (inherit/configured), Pi catalog integration, typed runtime delivery, native child conversation application, lifecycle/mirror fixes, instruction separation, and dual-circuit verification on latest BB SDK 0.6.79 without backwards compatibility.

**Architecture:** Thin adapter architecture adhering to AP-010..AP-071: BB owns the UI/storage policy settings via namespaced plugin KV (`subagent.policy.v1`) and `app.slots.settingsSection`; Pi owns model catalog and credential authority via `ModelRuntime` / `api.models`; Pi Durable owns child execution/configuration/ownership via native `AgentChange` inside durable transactions. A dedicated pure resolver service translates policy snapshots to native `ModelRef` and thinking levels, delivered monotonically across turn boundaries.

**Tech Stack:** TypeScript 5.7, Node.js 22 (node:test), @get-bb/plugin-sdk 0.6.79, @earendil-works/pi-durable 1.3.0, @earendil-works/pi-coding-agent 1.3.0, @earendil-works/pi-ai 1.3.0, Zod 4, React 19.

---

## 1. Architecture Context Map & AP Gates

- **Stage:** Production Adapter (`VanDalkvist/bb-plugin-provider-pi-durable`).
- **Critical AP Gates:**
  - `AP-010`: Modular Monolith / Ports & Adapters; project Thin Adapter policy.
  - `AP-011`: Low coupling and high cohesion.
  - `AP-012`: Fail-fast and explicit error contracts.
  - `AP-013`: User-data integrity.
  - `AP-016`: Trusted execution/security boundary.
  - `AP-019`: File line budgets (production TypeScript <200 lines when touched; focused extraction only).
  - `AP-020`: Clean Architecture boundaries and composition root.
  - `AP-022`: Typed errors and preserved causes.
  - `AP-023`: Async discipline and owned resources.
  - `AP-025`: Public imports only, no private SDK subpaths.
  - `AP-026`: API contracts, schemas and DTO boundaries.
  - `AP-027`: Validated configuration and environment.
  - `AP-028`: Deterministic tests and real SDK adapter fixtures.
  - `AP-034`: Explicit concurrency strategy.
  - `AP-035`: Idempotent externally repeatable commands.
  - `AP-038`: Cross-request/job traceability.
  - `AP-046`: Contract evolution without accidental breakage (user explicitly approves the new minimum SDK).
  - `AP-050`: Enum/status semantics as contracts.

---

## 2. Scope & Exclusions

### In Scope (v1)
1. **SDK 0.6.79 Migration:** Exact pin `@get-bb/plugin-sdk: "0.6.79"` in `dependencies`, `engines.bbPluginSdk: ">=0.6.79"`, `engines.bb: ">=0.47.1"`, Pi 1.3.0 preserved in lockfile, no legacy shims or backward-compatibility branches.
2. **Subagent Policy Contract & Resolver:** Canonical KV `subagent.policy.v1`, version 1, monotonic `revision`, discriminated union (`inherit` / `configured`), pure resolver mapping BB picker reasoning `"none"` ↔ Pi `"off"`, model-supported thinking levels, no hardcoded Gemini.
3. **KV Storage & Async Hydration:** Async server startup awaits `bb.storage.kv.get('subagent.policy.v1')` before registering provider and RPC; single writer with `expectedRevision` check; storage errors are observable (`SUBAGENT_POLICY_LOAD_ERROR`), not silent fallbacks.
4. **Typed Delivery & Root Guard:** `providerOptions.subagentPolicy` delivered on owner/root turns; runner acknowledges `set_subagent_policy` command before prompt execution; child mirror turns never mutate root session options or reconfigure child; child mirror model mismatch rejected with `CHILD_MODEL_POLICY_LOCKED`.
5. **Native Child Application & Replay:** Applied to task-owned child conversation in `api.commit` via `configure(tx, childId, { model, thinkingLevel, instructions })`; task brief separated from neutral technical role envelope; child metadata records policy source/revision; replay does not recreate `DefaultReporter` or reconfigure existing child; preserves `Anchor` and owner cancellation semantics.
6. **BB Settings Section UI:** Connected via `manifest.bb.app: "./app.tsx"` and `app.slots.settingsSection`; `experimental_ProviderModelPicker` locked to `pi-durable`; draft vs applied state; disabled picker in inherit mode; initial preview profile bootstrap via read-only host RPC without fake model IDs; scope clearly labeled as global per plugin/BB server.
7. **Lifecycle & Mirror Defect Fixes:** Fix premature `markSubagentCompleted` on background tool acknowledgment; mirror status accurately reflects `running`, `completed`, `aborted`, or `failed`; single child generation; extract subagent handling to bring `src/host/session.ts` < 200 lines.
8. **Instruction Separation:** Technical worker envelope specifies boundaries without task text or git archaeology bans; update local and workspace instruction guidance.
9. **Full Verification:** Dual-circuit independent review (Architecture & Product), unit/integration test suite, `bb plugin types --check`, build, package integrity.

### Explicitly Excluded (Out of Scope for v1)
- Modifying native Pi `settings.json` or writing custom keys into Pi SettingsManager.
- Standalone Pi-side sidecar configuration file (scope is BB-owned policy).
- Per-project, per-directory, or per-role model policy overrides.
- Per-call model arguments in `subagent({ task, background })` (LLM does not choose the model).
- Arbitrary custom role registries, prompt DSLs, or external graph orchestrators.
- Updating installed BB desktop app (confirmed at latest stable 0.47.1).
- Bumping Pi packages past 1.3.0 (retained at 1.3.0).
- Public git push, tagging, or release without explicit parent authorization.

---

## 3. Module Breakdown & Line Budgets (AP-019)

| Module File | Responsibility | Estimated Lines | Budget (< 200) |
|---|---|---|---|
| `src/policy/types.ts` | Shared TypeScript interfaces for policy, profiles, storage DTO, and RPC | ~70 lines | OK |
| `src/policy/schema.ts` | Zod runtime schemas for storage, RPC, and runner commands | ~110 lines | OK |
| `src/policy/resolver.ts` | Pure resolver mapping policy + parent context + model availability port | ~95 lines | OK |
| `src/policy/store.ts` | BB KV store implementation, async hydration, optimistic revision check | ~125 lines | OK |
| `src/runner/subagent-role.ts` | Neutral technical worker role envelope builder (no task interpolation) | ~35 lines | OK |
| `src/runner/subagent-policy-state.ts` | Runner in-memory holder for active acknowledged subagent policy | ~45 lines | OK |
| `src/host/session-subagent-handler.ts` | Extracted subagent event/lifecycle handler (fixes premature completion) | ~110 lines | OK |
| `src/ui/settings-subagent-section.tsx` | React settings section component with draft/applied form and picker | ~160 lines | OK |
| `src/ui/model-picker-bootstrap.ts` | Read-only model bootstrap helper for settings UI | ~50 lines | OK |
| `src/host/session.ts` (modified) | Root session coordinator with extracted subagent lifecycle handling | ~170 lines | OK (reduced from 240) |
| `src/runner/subagent.ts` (modified) | Native subagent tool applying resolved model and replay protection | ~130 lines | OK |
| `src/runner/session-commands.ts` (modified) | Runner command dispatcher handling `set_subagent_policy` | ~185 lines | OK |
| `server.ts` (modified) | Plugin entry, async KV hydration, RPC registration, `deriveProviderOptions` | ~90 lines | OK |
| `app.tsx` (modified) | Modern plugin app entry registering `slots.settingsSection` | ~40 lines | OK |

---

## 4. Shared Strict DTOs, Schemas & RPC Contracts

### Canonical Names & Keys
- **Canonical KV Storage Key:** `"subagent.policy.v1"`
- **Storage DTO Schema Version:** `1`
- **RPC Methods:**
  - `subagent_policy_get`: returns current `{ record: SubagentPolicyRecord }`
  - `subagent_policy_set`: input `{ policy: SubagentPolicy, expectedRevision: number }`, returns `{ record: SubagentPolicyRecord }`
  - `subagent_catalog_bootstrap`: input `{}`, returns `{ defaultProfile: SubagentModelProfile, availableModels: ModelReference[] }`
- **Runner Command Type:** `"set_subagent_policy"` with payload `{ policyRecord: SubagentPolicyRecord }`

### Wire DTO Types (`src/policy/types.ts`)
```typescript
export type SubagentPolicyMode = "inherit" | "configured";

export type SubagentThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SubagentModelReference {
  provider: string;
  modelId: string;
}

export interface SubagentModelProfile {
  model: SubagentModelReference;
  thinkingLevel: SubagentThinkingLevel;
}

export type SubagentPolicy =
  | { mode: "inherit"; configuredProfile?: SubagentModelProfile }
  | { mode: "configured"; configuredProfile: SubagentModelProfile };

export interface SubagentPolicyRecord {
  version: 1;
  revision: number;
  updatedAt: string;
  policy: SubagentPolicy;
}

export interface ModelAvailabilityPort {
  getModel(provider: string, modelId: string): { thinking?: boolean; reasoningLevels?: string[] } | undefined;
  hasCredentials(provider: string): boolean;
}

export interface ResolvedChildConfiguration {
  model: { provider: string; modelId: string };
  thinkingLevel: string;
  source: "parent_inherited" | "user_configured";
  policyRevision: number;
}
```

---

## 5. Detailed Ordered Implementation Tasks

### Task 1: Migration-Only Commit to SDK 0.6.79 & Baseline Hardening

**Boundary:** Package configuration, dependency versions, engine prerequisites, and build integrity.  
**AP Gates:** `AP-010`, `AP-019`, `AP-038`.  
**Files:**
- Modify: `package.json:1-45`
- Modify: `tests/package-integrity.test.ts:1-60`
- Target: `package-lock.json`

- [ ] **Step 1: Write the failing test for SDK 0.6.79 exact pin and engine constraints**

Edit `tests/package-integrity.test.ts` to assert the required versions:
```typescript
test("package.json integrity: @get-bb/plugin-sdk is strictly pinned to 0.6.79 and engines meet baseline", () => {
  const content = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(content);

  assert.equal(pkg.dependencies?.["@get-bb/plugin-sdk"], "0.6.79", "@get-bb/plugin-sdk must be exact 0.6.79");
  assert.equal(pkg.engines?.bbPluginSdk, ">=0.6.79", "engines.bbPluginSdk must require >=0.6.79");
  assert.equal(pkg.engines?.bb, ">=0.47.1", "engines.bb must require >=0.47.1");
  assert.equal(pkg.dependencies?.["@earendil-works/pi-durable"], "1.3.0", "Pi Durable must remain exact installed 1.3.0");
  assert.equal(pkg.dependencies?.["@earendil-works/pi-coding-agent"], "1.3.0", "Pi Coding Agent must remain exact installed 1.3.0");
  assert.equal(pkg.dependencies?.["@earendil-works/pi-codemode"], "1.3.0");
  assert.equal(pkg.overrides?.["@earendil-works/chord"], "1.3.0");
  assert.equal(pkg.overrides?.["@earendil-works/pi-ai"], "1.3.0");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/package-integrity.test.ts`  
Expected output: FAIL with `AssertionError: '@get-bb/plugin-sdk must be exact 0.6.79' (+ '^0.6.60' != '0.6.79')`

- [ ] **Step 3: Update `package.json` to exact SDK 0.6.79 and updated engine versions**

Update `package.json`:
- `"engines"`: `{"bb": ">=0.47.1", "bbPluginSdk": ">=0.6.79"}`
- `"dependencies"`: `"@get-bb/plugin-sdk": "0.6.79"` (pin existing `@earendil-works/pi-*` dependencies and chord/pi-ai overrides to exact installed `1.3.0`; a caret is not a 1.3 upper bound).
- Install the new SDK into node_modules as well as the lockfile, preserving exact root pin:
```bash
npm install --save-exact @get-bb/plugin-sdk@0.6.79
npm ls @get-bb/plugin-sdk @earendil-works/pi-durable @earendil-works/pi-coding-agent @earendil-works/pi-codemode
```
- Current-only API cleanup in `server.ts`: remove optional SDK feature probes (`bb.settings?.define?.`, `bb.rpc?.register?.`, `bb.onDispose?.`) in favor of the required current APIs. Validate return/dispose types against SDK0.6.79; registration cleanup belongs to the BB generation, do not invent a provider dispose handle.
- Generated `dist` artifacts may be refreshed by build; include only outputs from this slice in its commit. Do not install/reload the live plugin or push/tag/release.

- [ ] **Step 4: Run package integrity test, plugin types check, and full test suite**

Run:
```bash
node --test tests/package-integrity.test.ts
bb plugin types --check
npm run build
npm test
```
Expected output: PASS (all tests pass, `bb plugin types --check` succeeds with host 0.6.79 matching pin 0.6.79).

- [ ] **Step 5: Commit migration slice**

```bash
git add package.json package-lock.json tests/package-integrity.test.ts
git commit -m "chore: migrate to @get-bb/plugin-sdk 0.6.79 with engines >=0.47.1"
```

---

### Task 2: Shared Strict Subagent Policy DTOs, Schemas & Pure Resolver Service

**Boundary:** Domain & Validation Boundary.  
**AP Gates:** `AP-011` (Strict input validation), `AP-012` (Typed errors), `AP-020` (SRP), `AP-022` (Dependency Inversion), `AP-028` (Deterministic tests).  
**Files:**
- Create: `src/policy/types.ts`
- Create: `src/policy/schema.ts`
- Create: `src/policy/resolver.ts`
- Test: `tests/subagent-policy-schema.test.ts`
- Test: `tests/subagent-policy-resolver.test.ts`

- [ ] **Step 1: Write the failing tests for policy schemas and resolver**

Create `tests/subagent-policy-schema.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { subagentPolicyRecordSchema, subagentPolicySetInputSchema } from "../src/policy/schema.ts";

test("subagentPolicyRecordSchema accepts valid inherit policy", () => {
  const record = {
    version: 1,
    revision: 0,
    updatedAt: new Date().toISOString(),
    policy: { mode: "inherit" },
  };
  const parsed = subagentPolicyRecordSchema.parse(record);
  assert.equal(parsed.policy.mode, "inherit");
  assert.equal(parsed.revision, 0);
});

test("subagentPolicyRecordSchema rejects configured mode without configuredProfile", () => {
  const record = {
    version: 1,
    revision: 1,
    updatedAt: new Date().toISOString(),
    policy: { mode: "configured" },
  };
  assert.throws(() => subagentPolicyRecordSchema.parse(record));
});

test("subagentPolicyRecordSchema rejects unknown extra properties", () => {
  const record = {
    version: 1,
    revision: 1,
    updatedAt: new Date().toISOString(),
    policy: { mode: "inherit", unknownProp: 123 },
  };
  assert.throws(() => subagentPolicyRecordSchema.parse(record));
});
```

Create `tests/subagent-policy-resolver.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSubagentModelConfiguration } from "../src/policy/resolver.ts";
import type { SubagentPolicyRecord } from "../src/policy/types.ts";

test("resolveSubagentModelConfiguration: inherit mode uses calling parent model and thinking level", () => {
  const record: SubagentPolicyRecord = {
    version: 1,
    revision: 2,
    updatedAt: "2026-10-25T12:00:00Z",
    policy: { mode: "inherit" },
  };
  const parent = {
    model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
    thinkingLevel: "high",
  };
  const mockPort = {
    getModel: () => ({ thinking: true, reasoningLevels: ["low", "medium", "high"] }),
    hasCredentials: () => true,
  };

  const resolved = resolveSubagentModelConfiguration(record, parent, mockPort);
  assert.deepEqual(resolved, {
    model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
    thinkingLevel: "high",
    source: "parent_inherited",
    policyRevision: 2,
  });
});

test("resolveSubagentModelConfiguration: configured mode applies configured profile and maps none to off", () => {
  const record: SubagentPolicyRecord = {
    version: 1,
    revision: 5,
    updatedAt: "2026-10-25T12:00:00Z",
    policy: {
      mode: "configured",
      configuredProfile: {
        model: { provider: "google", modelId: "gemini-2.5-pro" },
        thinkingLevel: "low",
      },
    },
  };
  const parent = {
    model: { provider: "openai", modelId: "gpt-4o" },
    thinkingLevel: "off",
  };
  const mockPort = {
    getModel: (p: string, id: string) => (p === "google" && id === "gemini-2.5-pro" ? { thinking: true } : undefined),
    hasCredentials: (p: string) => p === "google",
  };

  const resolved = resolveSubagentModelConfiguration(record, parent, mockPort);
  assert.deepEqual(resolved, {
    model: { provider: "google", modelId: "gemini-2.5-pro" },
    thinkingLevel: "low",
    source: "user_configured",
    policyRevision: 5,
  });
});

test("resolveSubagentModelConfiguration: throws SUBAGENT_MODEL_UNAVAILABLE when configured model credentials missing", () => {
  const record: SubagentPolicyRecord = {
    version: 1,
    revision: 1,
    updatedAt: "2026-10-25T12:00:00Z",
    policy: {
      mode: "configured",
      configuredProfile: {
        model: { provider: "custom-provider", modelId: "deep-thought" },
        thinkingLevel: "off",
      },
    },
  };
  const parent = { model: { provider: "openai", modelId: "gpt-4o" }, thinkingLevel: "off" };
  const mockPort = {
    getModel: () => undefined,
    hasCredentials: () => false,
  };

  assert.throws(
    () => resolveSubagentModelConfiguration(record, parent, mockPort),
    (err: any) => err.code === "SUBAGENT_MODEL_UNAVAILABLE",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/subagent-policy-schema.test.ts tests/subagent-policy-resolver.test.ts`  
Expected output: FAIL with module not found (`../src/policy/schema.ts`).

- [ ] **Step 3: Implement `types.ts`, `schema.ts`, and `resolver.ts`**

Write `src/policy/types.ts`:
- Define `SubagentPolicyMode`, `SubagentThinkingLevel`, `SubagentModelProfile`, `SubagentPolicy`, `SubagentPolicyRecord`, `ModelAvailabilityPort`, `ResolvedChildConfiguration`.

Write `src/policy/schema.ts`:
- Use Zod (`z.object`, `z.discriminatedUnion("mode", ...)`, `z.strict()`).
- Validate strict enum for thinkingLevel: `["off", "low", "medium", "high", "xhigh", "max"]`.
- Define `subagentPolicyRecordSchema`, `subagentPolicySetInputSchema`.

Write `src/policy/resolver.ts`:
- Export `resolveSubagentModelConfiguration(record, parent, availabilityPort)`.
- If `mode === "inherit"`:
  - If parent model is missing, throw `SUBAGENT_POLICY_INVALID`.
  - Validate parent model against `availabilityPort`.
  - Return `{ model: parent.model, thinkingLevel: parent.thinkingLevel ?? "off", source: "parent_inherited", policyRevision: record.revision }`.
- If `mode === "configured"`:
  - Validate `configuredProfile.model` exists in `availabilityPort.getModel(...)`.
  - Validate `availabilityPort.hasCredentials(configuredProfile.model.provider)`.
  - If missing/uncredentialed: throw custom Error with `.code = "SUBAGENT_MODEL_UNAVAILABLE"` and descriptive message: `"Configured subagent model ${provider}/${modelId} is unavailable or unauthenticated on this host. Open Settings → Pi Durable → Subagents to reconfigure."`.
  - Return `{ model: configuredProfile.model, thinkingLevel: configuredProfile.thinkingLevel, source: "user_configured", policyRevision: record.revision }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/subagent-policy-schema.test.ts tests/subagent-policy-resolver.test.ts`  
Expected output: PASS (all tests pass).

- [ ] **Step 5: Commit policy contract and resolver**

```bash
git add src/policy/ tests/subagent-policy-schema.test.ts tests/subagent-policy-resolver.test.ts
git commit -m "feat(policy): implement strict subagent policy schemas, DTOs and pure resolver"
```

---

### Task 3: Policy KV Store & Hydration Service in Server Entry

**Boundary:** Infrastructure Adapter / BB Plugin Storage & RPC Registration.  
**AP Gates:** `AP-016` (Single writer, expectedRevision), `AP-020` (SRP), `AP-022` (DIP), `AP-038` (Schema versioning).  
**Files:**
- Create: `src/policy/store.ts`
- Modify: `server.ts`
- Modify: `src/rpc/contract.ts`
- Test: `tests/subagent-policy-store.test.ts`

- [ ] **Step 1: Write the failing tests for `SubagentPolicyStore`**

Create `tests/subagent-policy-store.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { SubagentPolicyStore } from "../src/policy/store.ts";

test("SubagentPolicyStore: hydrates canonical inherit default on clean storage", async () => {
  const fakeKv = new Map<string, unknown>();
  const store = new SubagentPolicyStore({
    get: async (k) => fakeKv.get(k),
    set: async (k, v) => fakeKv.set(k, v),
  });

  await store.hydrate();
  const record = store.getRecord();
  assert.equal(record.version, 1);
  assert.equal(record.revision, 0);
  assert.equal(record.policy.mode, "inherit");
});

test("SubagentPolicyStore: setPolicy updates revision monotonically", async () => {
  const fakeKv = new Map<string, unknown>();
  const store = new SubagentPolicyStore({
    get: async (k) => fakeKv.get(k),
    set: async (k, v) => fakeKv.set(k, v),
  });
  await store.hydrate();

  const updated = await store.setPolicy(
    {
      mode: "configured",
      configuredProfile: {
        model: { provider: "google", modelId: "gemini-2.5-flash" },
        thinkingLevel: "high",
      },
    },
    0, // expectedRevision
  );

  assert.equal(updated.revision, 1);
  assert.equal(updated.policy.mode, "configured");
  assert.equal(store.getRecord().revision, 1);
});

test("SubagentPolicyStore: throws REVISION_CONFLICT on mismatched expectedRevision without saving", async () => {
  const fakeKv = new Map<string, unknown>();
  const store = new SubagentPolicyStore({
    get: async (k) => fakeKv.get(k),
    set: async (k, v) => fakeKv.set(k, v),
  });
  await store.hydrate();

  await assert.rejects(
    () => store.setPolicy({ mode: "inherit" }, 99),
    (err: any) => err.code === "REVISION_CONFLICT",
  );
  assert.equal(store.getRecord().revision, 0);
});

test("SubagentPolicyStore: throws SUBAGENT_POLICY_LOAD_ERROR when storage contains corrupted data", async () => {
  const fakeKv = new Map<string, unknown>();
  fakeKv.set("subagent.policy.v1", { corrupted: true });
  const store = new SubagentPolicyStore({
    get: async (k) => fakeKv.get(k),
    set: async (k, v) => fakeKv.set(k, v),
  });

  await assert.rejects(
    () => store.hydrate(),
    (err: any) => err.code === "SUBAGENT_POLICY_LOAD_ERROR",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/subagent-policy-store.test.ts`  
Expected output: FAIL with module not found (`../src/policy/store.ts`).

- [ ] **Step 3: Implement `SubagentPolicyStore`, update `src/rpc/contract.ts` and `server.ts`**

Write `src/policy/store.ts`:
- Implement `SubagentPolicyStore`:
  - `hydrate()`: reads `"subagent.policy.v1"`. If undefined, initializes default inherit record with revision 0. If schema validation fails, throws error with `code: "SUBAGENT_POLICY_LOAD_ERROR"`.
  - `getRecord()`: returns current immutable snapshot.
  - `setPolicy(policy, expectedRevision)`: validates `policy` with `subagentPolicySchema`. Verifies `expectedRevision === current.revision`. If mismatch, throws Error with `code: "REVISION_CONFLICT"`. Persists whole record to KV with incremented `revision: current.revision + 1` and `updatedAt: new Date().toISOString()`. Updates in-memory cache upon persistence success.

Update `src/rpc/contract.ts`:
- Define RPC contracts:
  - `subagent_policy_get`: output `z.object({ record: subagentPolicyRecordSchema })`
  - `subagent_policy_set`: input `z.object({ policy: subagentPolicySchema, expectedRevision: z.number().int().nonnegative() })`, output `z.object({ record: subagentPolicyRecordSchema })`
  - `subagent_catalog_bootstrap`: output `z.object({ defaultProfile: subagentModelProfileSchema.optional(), availableModels: z.array(z.object({ provider: z.string(), modelId: z.string(), displayName: z.string().optional() })) })`

Update `server.ts`:
- Make plugin initialization async if supported by SDK or instantiate store, await `store.hydrate()` before registering RPC and provider.
- In `deriveProviderOptions(ctx)`: inject `subagentPolicy: store.getRecord()`.

- [ ] **Step 4: Run store tests and full test suite**

Run: `node --test tests/subagent-policy-store.test.ts tests/thinking-presentation.test.ts`  
Expected output: PASS (all tests pass).

- [ ] **Step 5: Commit policy store and server integration**

```bash
git add src/policy/store.ts src/rpc/contract.ts server.ts tests/subagent-policy-store.test.ts
git commit -m "feat(policy): implement SubagentPolicyStore in KV with optimistic locking and RPC integration"
```

---

### Task 4: Runner Subagent Policy Command and Native Model Availability Port

**Boundary:** Runner Process & Session Command Boundary.  
**AP Gates:** `AP-011`, `AP-012`, `AP-020`, `AP-022`, `AP-025`.  
**Files:**
- Create: `src/runner/subagent-policy-state.ts`
- Modify: `src/runner/session-commands.ts`
- Test: `tests/runner-subagent-policy.test.ts`

- [ ] **Step 1: Write the failing test for runner subagent policy handling**

Create `tests/runner-subagent-policy.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { handleActiveSessionCommand } from "../src/runner/session-commands.ts";
import { getActiveSubagentPolicy, resetActiveSubagentPolicy } from "../src/runner/subagent-policy-state.ts";

test("runner handles set_subagent_policy command and acknowledges success", async () => {
  resetActiveSubagentPolicy();
  const policyRecord = {
    version: 1,
    revision: 3,
    updatedAt: "2026-10-25T12:00:00Z",
    policy: {
      mode: "configured",
      configuredProfile: {
        model: { provider: "google", modelId: "gemini-2.5-flash" },
        thinkingLevel: "medium",
      },
    },
  };

  let respondedSuccess = false;
  const mockResponder = {
    success: (id: any, command: string) => {
      if (command === "set_subagent_policy") respondedSuccess = true;
    },
    error: (id: any, command: string, msg: string) => {
      assert.fail(`Unexpected error response: ${msg}`);
    },
  };

  await handleActiveSessionCommand(
    { type: "set_subagent_policy", id: "req-1", policyRecord: policyRecord as any },
    {} as any,
    { getAvailableSnapshot: () => [], getModel: () => undefined, hasConfiguredAuth: () => true } as any,
    {} as any,
    mockResponder,
  );

  assert.equal(respondedSuccess, true);
  assert.deepEqual(getActiveSubagentPolicy(), policyRecord);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/runner-subagent-policy.test.ts`  
Expected output: FAIL with module not found (`../src/runner/subagent-policy-state.ts`).

- [ ] **Step 3: Implement `subagent-policy-state.ts` and update `session-commands.ts`**

Write `src/runner/subagent-policy-state.ts`:
```typescript
import type { SubagentPolicyRecord } from "../policy/types.ts";

let activePolicyRecord: SubagentPolicyRecord = {
  version: 1,
  revision: 0,
  updatedAt: new Date(0).toISOString(),
  policy: { mode: "inherit" },
};

export function getActiveSubagentPolicy(): SubagentPolicyRecord {
  return activePolicyRecord;
}

export function setActiveSubagentPolicy(record: SubagentPolicyRecord): void {
  activePolicyRecord = record;
}

export function resetActiveSubagentPolicy(): void {
  activePolicyRecord = {
    version: 1,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    policy: { mode: "inherit" },
  };
}
```

Update `src/runner/session-commands.ts`:
- In `RunnerCommandPayload`: add `policyRecord?: SubagentPolicyRecord`.
- In `handleActiveSessionCommand`: add `case "set_subagent_policy"`:
  - Validate `cmd.policyRecord`. If missing, `respond.error(cmd.id, "set_subagent_policy", "Missing policyRecord")`.
  - Call `setActiveSubagentPolicy(cmd.policyRecord)`.
  - Call `respond.success(cmd.id, "set_subagent_policy")`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/runner-subagent-policy.test.ts`  
Expected output: PASS (all tests pass).

- [ ] **Step 5: Commit runner policy command**

```bash
git add src/runner/subagent-policy-state.ts src/runner/session-commands.ts tests/runner-subagent-policy.test.ts
git commit -m "feat(runner): handle set_subagent_policy runner command and maintain active policy state"
```

---

### Task 5: Native Subagent Execution: Model Application, Role Separation & Replay Safety

**Boundary:** Runner Execution & Pi Durable Harness Integration.  
**AP Gates:** `AP-010` (Thin Adapter), `AP-020` (SRP), `AP-026` (Replay safety), `AP-027` (No duplicate side effects).  
**Files:**
- Create: `src/runner/subagent-role.ts`
- Modify: `src/runner/subagent.ts`
- Test: `tests/subagent-native-model-application.test.ts`

- [ ] **Step 1: Write the failing tests for neutral role separation and native model application**

Create `tests/subagent-native-model-application.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { Harness, MemoryStorage, createRegistry, AgentDoc } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { runtimeContext as ctx } from "../src/runner/runtime-types.ts";
import { Subagent } from "../src/runner/subagent.ts";
import { Anchor } from "../src/runner/subagent-delivery.ts";
import { setActiveSubagentPolicy, resetActiveSubagentPolicy } from "../src/runner/subagent-policy-state.ts";
import { buildTechnicalWorkerRole } from "../src/runner/subagent-role.ts";

test("buildTechnicalWorkerRole: does NOT interpolate task prompt or ban git archaeology", () => {
  const role = buildTechnicalWorkerRole();
  assert.match(role, /isolated worker subagent/i);
  assert.equal(role.includes("archeology"), false);
  assert.equal(role.includes("archaeology"), false);
  assert.equal(role.includes("ONLY goal is to solve the delegated task"), false);
});

test("Subagent execution: configured policy applies configured model and thinking level to child conversation", async () => {
  resetActiveSubagentPolicy();
  setActiveSubagentPolicy({
    version: 1,
    revision: 10,
    updatedAt: new Date().toISOString(),
    policy: {
      mode: "configured",
      configuredProfile: {
        model: { provider: "mock-provider", modelId: "mock-fast-model" },
        thinkingLevel: "low",
      },
    },
  });

  const registry = createRegistry();
  registry.install(Subagent);
  registry.install(Anchor);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models: createModels(), registry }, ctx);

  try {
    const root = await harness.root(ctx, {
      agent: {
        cwd: "/tmp",
        model: { provider: "parent-provider", modelId: "parent-heavy-model" },
        thinkingLevel: "high",
      },
    });
    const owner = await root.commit(
      (tx) => tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true }),
      ctx,
    );

    let childId: any;
    const sentinel = new Error("STOP_AFTER_SPAWN");
    await assert.rejects(
      () =>
        Subagent.tools[0].execute(
          { task: "Execute targeted unit tests", background: true },
          {
            taskId: owner,
            conversationId: root.id,
            commit: (fn: any) => root.commit(fn, ctx),
            details: async (d: any) => {
              childId = d.conversationId;
              throw sentinel;
            },
          } as any,
          ctx,
        ),
      (err) => err === sentinel,
    );

    const childDoc = await harness.snapshot(AgentDoc, childId, ctx);
    assert.deepEqual(childDoc.model, { provider: "mock-provider", modelId: "mock-fast-model" });
    assert.equal(childDoc.thinkingLevel, "low");
    assert.match(childDoc.instructions ?? "", /isolated worker subagent/i);

    // Parent AgentDoc must remain completely untouched!
    const parentDoc = await harness.snapshot(AgentDoc, root.id, ctx);
    assert.deepEqual(parentDoc.model, { provider: "parent-provider", modelId: "parent-heavy-model" });
    assert.equal(parentDoc.thinkingLevel, "high");
  } finally {
    await harness.close(ctx);
    await storage.close();
    resetActiveSubagentPolicy();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/subagent-native-model-application.test.ts`  
Expected output: FAIL with module not found (`../src/runner/subagent-role.ts`).

- [ ] **Step 3: Implement `subagent-role.ts` and update `subagent.ts`**

Write `src/runner/subagent-role.ts`:
```typescript
export function buildTechnicalWorkerRole(): string {
  return [
    "You are an isolated worker subagent.",
    "Your role is to execute the delegated task using your available tools and return your final answer concisely.",
    "Rules:",
    "- Focus strictly on solving the assigned task.",
    "- Execute the task directly and report findings clearly.",
  ].join("\n");
}
```

Update `src/runner/subagent.ts`:
- Import `buildTechnicalWorkerRole` from `./subagent-role.ts`.
- Import `getActiveSubagentPolicy` from `./subagent-policy-state.ts`.
- In tool `execute`:
  - When creating child conversation:
    - Read parent `AgentDoc` via `await tx.doc(AgentDoc, api.conversationId)`.
    - Read active policy via `getActiveSubagentPolicy()`.
    - Determine effective child model and thinking level:
      - If policy is `configured`: use `configuredProfile.model` and `configuredProfile.thinkingLevel`.
      - If policy is `inherit`: use `parentDoc.model` and `parentDoc.thinkingLevel`.
    - Call `await configure(tx, created.id, { instructions: buildTechnicalWorkerRole(), model: effectiveModel, thinkingLevel: effectiveThinkingLevel })`.
  - Replay guard:
    - If `existing` conversation exists: DO NOT reconfigure child model or instructions!
    - Only call `tx.createTask(DefaultReporter, ...)` if `record.reporter === undefined`.
  - Ensure `child` metadata includes `policyRevision` and `source` for observable diagnostics.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/subagent-native-model-application.test.ts`  
Expected output: PASS (all tests pass).

- [ ] **Step 5: Commit native subagent model application**

```bash
git add src/runner/subagent-role.ts src/runner/subagent.ts tests/subagent-native-model-application.test.ts
git commit -m "feat(runner): configure native child model and thinking level from subagent policy"
```

---

### Task 6: Host Reconcile, ProviderOptions Delivery & Root Bridge Guard

**Boundary:** Host Session Options & Provider Bridge Router.  
**AP Gates:** `AP-016` (No split brain), `AP-019` (Line budgets < 200), `AP-020` (SRP), `AP-028` (Test isolation).  
**Files:**
- Modify: `src/host/session-reconcile.ts`
- Modify: `src/host/bridge-router.ts`
- Modify: `src/host/session.ts`
- Test: `tests/host-subagent-policy-delivery.test.ts`

- [ ] **Step 1: Write the failing tests for root delivery and child mirror isolation**

Create `tests/host-subagent-policy-delivery.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { reconcileSessionOptions } from "../src/host/session-reconcile.ts";

test("reconcileSessionOptions sends set_subagent_policy when subagentPolicy changed on root thread", async () => {
  let dispatchedCommand: any = null;
  const mockSession = {
    options: {
      threadId: "root-thread-1",
      providerOptions: {},
    },
    setSubagentPolicy: async (record: any) => {
      dispatchedCommand = record;
    },
  };

  const newPolicyRecord = {
    version: 1,
    revision: 4,
    updatedAt: "2026-10-25T12:00:00Z",
    policy: { mode: "inherit" },
  };

  await reconcileSessionOptions(mockSession as any, {
    providerOptions: { subagentPolicy: newPolicyRecord },
  });

  assert.deepEqual(dispatchedCommand, newPolicyRecord);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/host-subagent-policy-delivery.test.ts`  
Expected output: FAIL (`dispatchedCommand` is null).

- [ ] **Step 3: Update `session-reconcile.ts`, `bridge-router.ts`, and `session.ts`**

Update `src/host/session-reconcile.ts`:
- Extend `ReconcilableSession` interface to include `setSubagentPolicy?(record: any): Promise<void>`.
- In `reconcileSessionOptions`:
  - Check `options.providerOptions?.subagentPolicy`.
  - If present and its `revision !== (session.options.providerOptions as any)?.subagentPolicy?.revision`:
    - Await `session.setSubagentPolicy?.(subagentPolicy)`.
    - Update `session.options.providerOptions = { ...session.options.providerOptions, subagentPolicy }`.

Update `src/host/bridge-router.ts`:
- In `handleTurnStart` and `handleTurnSteer`:
  - Check `const isRootThread = params.threadId === session.options.threadId;`
  - If `!isRootThread`:
    - DO NOT mutate `session.options.providerOptions`!
    - DO NOT call `reconcileSessionOptions(session, params.options)` on the root session!
    - If `params.options?.model` is specified and differs from the child conversation's model, send JSON-RPC error `-32602` with `"CHILD_MODEL_POLICY_LOCKED: Subagent model is managed by provider policy and cannot be overridden from child mirror."`

Update `src/host/session.ts`:
- Add `public async setSubagentPolicy(record: any): Promise<void>` which calls `await this.runner.requestOk({ type: "set_subagent_policy", policyRecord: record })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/host-subagent-policy-delivery.test.ts tests/subagent-mirror-guard.test.ts`  
Expected output: PASS (all tests pass).

- [ ] **Step 5: Commit host reconciliation and bridge guard**

```bash
git add src/host/session-reconcile.ts src/host/bridge-router.ts src/host/session.ts tests/host-subagent-policy-delivery.test.ts
git commit -m "feat(host): reconcile subagent policy on root turn and guard root session from child mirror mutations"
```

---

### Task 7: Fix Host Premature markCompleted, Lifecycle & Single Generation

**Boundary:** Host Session Lifecycle & Subagent Mirror Management.  
**AP Gates:** `AP-012`, `AP-013`, `AP-019` (Line budget < 200 lines), `AP-026`, `AP-046`.  
**Files:**
- Create: `src/host/session-subagent-handler.ts` (bounded extraction from `session.ts`)
- Modify: `src/host/session.ts`
- Modify: `src/host/subagent-mirror.ts`
- Test: `tests/subagent-lifecycle-fixes.test.ts`

- [ ] **Step 1: Write the failing tests for background spawn acknowledgment and mirror lifecycle**

Create `tests/subagent-lifecycle-fixes.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { PiThreadSession } from "../src/host/session.ts";
import { SubagentMirrorManager } from "../src/host/subagent-mirror.ts";

test("background spawn acknowledgment must NOT mark running subagent completed", async () => {
  const session = Object.create(PiThreadSession.prototype);
  session.options = { threadId: "probe-parent", cwd: "/tmp" };
  session.mirrors = new SubagentMirrorManager();
  session.bindings = { getThreadId: () => undefined };
  session.translator = { translate: () => [] };
  session.sendNotification = () => {};

  session.markSubagentActive("42", { task: "Background worker", parentToolCallId: "call-1" });

  await session.handleRunnerEvent({
    type: "tool_execution_end",
    toolName: "subagent",
    toolCallId: "call-1",
    result: "Subagent spawned in background (conversation 42).",
    details: { conversationId: "42", background: true, task: "Background worker" },
  });

  const state = session.getSubagentState("42");
  assert.equal(state?.status, "running", "Background subagent must remain running after spawn ack");
});

test("foreground execution end DOES mark subagent completed with result", async () => {
  const session = Object.create(PiThreadSession.prototype);
  session.options = { threadId: "probe-parent", cwd: "/tmp" };
  session.mirrors = new SubagentMirrorManager();
  session.bindings = { getThreadId: () => undefined };
  session.translator = { translate: () => [] };
  session.sendNotification = () => {};

  session.markSubagentActive("43", { task: "Sync worker", parentToolCallId: "call-2" });

  await session.handleRunnerEvent({
    type: "tool_execution_end",
    toolName: "subagent",
    toolCallId: "call-2",
    result: "Final calculation result: 42",
    details: { conversationId: "43", background: false, task: "Sync worker" },
  });

  const state = session.getSubagentState("43");
  assert.equal(state?.status, "completed");
  assert.equal(state?.result, "Final calculation result: 42");
});

test("aborted or failed child agent_end records accurate outcome status", async () => {
  const session = Object.create(PiThreadSession.prototype);
  session.options = { threadId: "probe-parent", cwd: "/tmp" };
  session.mirrors = new SubagentMirrorManager();
  session.bindings = { getThreadId: () => "child-thread-99" };
  session.translator = { translate: () => [] };
  session.getChildTranslator = () => ({ translate: () => [] });
  const notifications: any[] = [];
  session.sendNotification = (method: string, params: any) => notifications.push({ method, params });

  session.markSubagentActive("99", { task: "Aborted worker" });

  await session.handleRunnerEvent({
    type: "agent_end",
    conversationId: "99",
    stopReason: "aborted",
  });

  const state = session.getSubagentState("99");
  assert.equal(state?.status, "completed");
  const boundary = notifications.find((n) => n.method === "thread/delta" && n.params.deltas?.[0]?.kind === "turn.boundary");
  assert.equal(boundary?.params.deltas[0].status, "interrupted");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/subagent-lifecycle-fixes.test.ts`  
Expected output: FAIL with `AssertionError: 'completed' == 'running'`.

- [ ] **Step 3: Extract `src/host/session-subagent-handler.ts` and fix lifecycle in `src/host/session.ts`**

Write `src/host/session-subagent-handler.ts`:
- Encapsulate `handleSubagentRunnerEvent(session, event)`:
  - If `event.type === "tool_execution_start"` and `event.toolName === "subagent"`: register mirror active, call `spawnSubthreadInBb` if new.
  - If `event.type === "tool_execution_end"` and `event.toolName === "subagent"`:
    - Check `event.details?.background`:
      - If `background === true`: DO NOT mark completed! Log debug and return.
      - If `background === false`: call `session.markSubagentCompleted(conversationId, result)`.
  - If child event and `event.type === "agent_end"`:
    - Check `event.stopReason`:
      - If `"aborted"`: emit `turn.boundary` with `status: "interrupted"`.
      - If `"error"`: emit `turn.boundary` with `status: "failed"`.
      - Otherwise: emit `turn.boundary` with `status: "completed"`.
    - Call `session.markSubagentCompleted(conversationId)`.

Update `src/host/session.ts`:
- Delegate subagent event handling to `handleSubagentRunnerEvent`.
- Verify `wc -l src/host/session.ts` is strictly < 200 lines (e.g. ~170 lines).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/subagent-lifecycle-fixes.test.ts tests/subagent-early-completion-race.test.ts`  
Expected output: PASS (all tests pass).

- [ ] **Step 5: Commit lifecycle fix and session modularization**

```bash
git add src/host/session-subagent-handler.ts src/host/session.ts src/host/subagent-mirror.ts tests/subagent-lifecycle-fixes.test.ts
git commit -m "fix(host): prevent premature completion on background spawn ack and clean up mirror lifecycle"
```

---

### Task 8: BB Settings UI and Model Picker Section

**Boundary:** UI Component & Settings Section Slot Boundary.  
**AP Gates:** `AP-010` (Thin Adapter), `AP-011` (Schema validation), `AP-019` (Line budget < 200), `AP-020` (SRP), `AP-034` (ISP).  
**Files:**
- Create: `src/ui/settings-subagent-section.tsx`
- Create: `src/ui/model-picker-bootstrap.ts`
- Modify: `app.tsx`
- Modify: `package.json` (add `"app": "./app.tsx"` in `"bb"`)
- Test: `tests/ui-settings-contract.test.ts`

- [ ] **Step 1: Write the failing test for UI settings registration contract**

Create `tests/ui-settings-contract.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("package.json registers bb.app pointing to ./app.tsx", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(pkg.bb?.app, "./app.tsx", "bb.app must point to ./app.tsx");
});

test("app.tsx exports definePluginApp registering slots.settingsSection", async () => {
  const content = fs.readFileSync("app.tsx", "utf8");
  assert.match(content, /slots:\s*{\s*settingsSection/);
  assert.equal(content.includes("DoctorView"), false, "app.tsx must not mount unrequested DoctorView as default app");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ui-settings-contract.test.ts`  
Expected output: FAIL (`pkg.bb?.app` is undefined).

- [ ] **Step 3: Implement `settings-subagent-section.tsx`, `model-picker-bootstrap.ts`, and update `app.tsx` & `package.json`**

Write `src/ui/model-picker-bootstrap.ts`:
- Define helper to fetch real initial profile from host RPC `subagent_catalog_bootstrap` without fake model IDs.

Write `src/ui/settings-subagent-section.tsx`:
- Render settings section:
  - Header: "Субагенты" with subtitle "Настройки политики модели для фоновых и синхронных субагентов".
  - Radio/Segmented control:
    - Option 1: "Наследовать от родителя" (`inherit`)
    - Option 2: "Использовать настроенную" (`configured`)
  - Model & Reasoning Picker:
    - Component: `experimental_ProviderModelPicker` from `@get-bb/plugin-sdk/app`.
    - Props: `providerId="pi-durable"`, `disabled={draft.mode === "inherit"}`.
    - If `draft.mode === "inherit"`: show hint "Модель родителя; сохранённая модель сейчас не используется".
  - Scope notice: "Один глобальный профиль для этого плагина на сервере BB (применится к новым субагентам со следующего хода)."
  - Action footer:
    - "Сохранить" button: disabled if `draft` equals `applied` or if `draft.mode === "configured"` and no valid model selected.
    - Error banner: handles `REVISION_CONFLICT` with "Конфигурация была изменена в другом окне. Перезагрузить или Сохранить поверх".

Update `app.tsx`:
- Export `definePluginApp({ slots: { settingsSection: SubagentSettingsSection } })`.
- Remove default `DoctorView`.

Update `package.json`:
- In `"bb"`: add `"app": "./app.tsx"`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --test tests/ui-settings-contract.test.ts
bb plugin types --check
npm run build
```
Expected output: PASS (build succeeds, types check passes).

- [ ] **Step 5: Commit settings UI and manifest update**

```bash
git add package.json app.tsx src/ui/ tests/ui-settings-contract.test.ts
git commit -m "feat(ui): add SubagentSettingsSection with experimental_ProviderModelPicker and manifest app entry"
```

---

### Task 9: Instruction Docs Scoping & Thin Adapter Clarification

**Boundary:** Workspace Documentation & Repository Operating Contract.  
**AP Gates:** `AP-010` (Thin Adapter), `AP-020` (SRP).  
**Files:**
- Modify: `AGENTS.md` (local repo)
- Test: `tests/instructions-conformance.test.ts`

- [ ] **Step 1: Write the failing test for instruction conformance**

Create `tests/instructions-conformance.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("repo AGENTS.md clarifies Thin Adapter role envelope and removes prompt hardcoding", () => {
  const content = fs.readFileSync("AGENTS.md", "utf8");
  assert.match(content, /The Thin Adapter Invariant/);
  assert.match(content, /Technical role contract envelope/);
  assert.equal(content.includes("claude-sonnet-4-6"), false, "Do not hardcode specific model names in repo instructions");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/instructions-conformance.test.ts`  
Expected output: FAIL.

- [ ] **Step 3: Update `AGENTS.md`**

Update `AGENTS.md`:
- Clarify that minimal technical role contract envelope in `subagent-role.ts` is permitted as a native tool contract.
- Clarify that base prompt remains upstream `@earendil-works/pi-coding-agent`.
- Document that coordinator rules apply to root orchestrator, while subagents operate as workers governed by runtime subagent policy.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/instructions-conformance.test.ts`  
Expected output: PASS.

- [ ] **Step 5: Commit instruction updates**

```bash
git add AGENTS.md tests/instructions-conformance.test.ts
git commit -m "docs(arch): clarify thin adapter role contract and coordinator-only scoping in AGENTS.md"
```

---

### Task 10: Dual Independent Reviews, Verification & S6 Plan Artifact Handover

**Boundary:** Quality Verification Gate & Orchestrator Handoff.  
**AP Gates:** All AP-010..AP-071 gates.  
**Files:**
- Output artifact: `/Users/vanya/.bb/thread-storage/thr_3e4z9meeqs/subagent-policy-implementation-plan.md`

- [ ] **Step 1: Run complete repository verification suite**

Run:
```bash
npm test
bb plugin types --check
npm run build
node scripts/doctor.mjs
```
Expected output: All 330+ tests PASS, types check clean, build succeeds.

- [ ] **Step 2: Dual-circuit review preparation (S7 Gate)**
  - Circuit 1: Architectural Review (`arch-rules-implementation-review`) checking AP-010..AP-071 and line budgets.
  - Circuit 2: Product Review (`arch-improvement-product-review`) checking inherit/configured journeys, error messages, and UX expectations.

- [ ] **Step 3: Finalize plan delivery under parent thread storage**
  - Verify plan artifact is saved to `/Users/vanya/.bb/thread-storage/thr_3e4z9meeqs/subagent-policy-implementation-plan.md`.
  - Signal readiness to parent orchestrator (`thr_3e4z9meeqs`).

---

## 6. Requirements Coverage Matrix

| User & Research Requirement | Planned Task | Architecture Boundary | Verification Evidence |
|---|---|---|---|
| **Exact SDK 0.6.79 migration** (no backwards compat, engines >= 0.47.1 & >= 0.6.79, Pi 1.3.0 locked) | Task 1 | Package / Build | `bb plugin types --check`, `package-integrity.test.ts` |
| **Centralized user model policy** (inherit / configured, canonical KV `subagent.policy.v1`, monotonic revision) | Task 2, Task 3 | Domain / Storage | `subagent-policy-schema.test.ts`, `subagent-policy-store.test.ts` |
| **Model catalog from Pi & thinking level mapping** (`none` ↔ `off`, model supported levels, no hardcoded Gemini) | Task 2, Task 4 | Domain / Runner | `subagent-policy-resolver.test.ts`, `runner-subagent-policy.test.ts` |
| **Native child conversation application** (`AgentChange`, task brief separate from technical role envelope, parent untouched) | Task 5 | Runner / Pi Durable | `subagent-native-model-application.test.ts` |
| **Replay & cancel safety** (existing child not reconfigured, reporter not duplicated, Anchor preserved) | Task 5 | Runner / Pi Durable | `subagent-native-model-application.test.ts` |
| **Typed delivery & root bridge guard** (next owner turn delivery, child mirror never mutates root, locked error) | Task 6 | Host / Bridge | `host-subagent-policy-delivery.test.ts`, `subagent-mirror-guard.test.ts` |
| **BB settingsSection UI** (`experimental_ProviderModelPicker`, draft/applied, inherit disabled, manifest app entry) | Task 8 | Frontend / Slot | `ui-settings-contract.test.ts`, `npm run build` |
| **Fix premature markCompleted on spawn ack** (background vs sync, status mirrors, single child generation) | Task 7 | Host / Lifecycle | `subagent-lifecycle-fixes.test.ts` |
| **File line budgets (< 200 lines)** (extract subagent handler from `src/host/session.ts`) | Task 7 | Architecture / SRP | `wc -l src/host/*.ts` |
| **Instruction docs & Thin Adapter clarification** (coordinator-only scoping, neutral envelope) | Task 9 | Documentation | `instructions-conformance.test.ts` |
| **Dual independent reviews & zero production edits during planning** | Task 10 | Quality Gate | Clean git working tree preserved |

---

## 7. Residual Risks & Mitigations

1. **Risk:** Cold-start race between KV read and provider options derivation.  
   **Mitigation:** Async server factory awaits `store.hydrate()` before registering provider and RPC. Failed reads throw observable error rather than falling back to inherit.
2. **Risk:** Host/runner concurrency when user updates policy mid-turn.  
   **Mitigation:** Policy update is monotonic and delivered on next owner/root turn boundary. Runner acknowledges command before prompt/steer submission. Each child admissions snapshot is immutable.
3. **Risk:** Missing model credentials on secondary machine.  
   **Mitigation:** Pure resolver throws typed `SUBAGENT_MODEL_UNAVAILABLE` with actionable UI path ("Settings → Pi Durable → Subagents"), non-retryable.
4. **Risk:** Background subagent completion race with mirror registration.  
   **Mitigation:** Task 7 strictly disallows `tool_execution_end` from completing background subagents, relying on child `agent_end` or task settlement.
5. **Risk:** Line budget regression in `src/host/session.ts` (currently 240 lines).  
   **Mitigation:** Task 7 extracts `session-subagent-handler.ts` (~110 lines), reducing `session.ts` to ~170 lines, cleanly complying with AP-019 (< 200 lines).

---

## 8. Handover & Execution Instructions

This plan is written for the parent orchestrator in thread `@thread:thr_3e4z9meeqs`.
- The repository source remains **completely untouched** (clean git working tree on main HEAD 4d02d4c).
- No subagents were spawned.
- After parent review and canonical capture to GBrain (`docs/research/pi-durable-subagent-settings-policy-architecture-2026-10-25`), independent S7 plan reviews must be executed before code changes begin.
