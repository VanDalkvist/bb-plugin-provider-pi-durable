# Subagent Model Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Canonical location:** This repository file is the working execution plan, per the user's explicit correction on 2026-10-25. Thread-storage copies are drafts, not the source of truth.

## Current execution checklist — code verified, not deployed

The checklist below is the current execution state. Detailed per-step checkboxes farther down are the preserved pre-execution design/command examples, **not remaining work**; where implementation refined a filename or seam, the actual code, tests and receipts below govern. No claim is made that every illustrative command was run verbatim.

- [x] Task 1 — SDK migration: `1deba49`; exact SDK 0.6.79 / Pi 1.3.0, public current APIs and root entry typecheck.
- [x] Tasks 2–3 — policy schema/resolver/store/RPC: `4754427`; strict union, serialized CAS, hydrate-before-registration, observable failures.
- [x] Tasks 4–5 — native acknowledged snapshot, restore/replay and child admission: `43f9362`, `4ba97b0`; instance isolation, validated model/thinking, immutable admitted profile and neutral role.
- [x] Tasks 6–7 — owner delivery, root/child isolation and real mirror outcomes: `d4a091e`; corrected cold DTO/manual-root cases in `8cce858`, `9416d0d`.
- [x] Task 7b — external Zod and canonical command only: `6067b6f`; runner 143947 bytes.
- [x] Task 8 — public SDK settings slot/picker/catalog preview: `53c6c6b`; no custom catalog bootstrap RPC; cancellation, Save and empty/error fixes in `8cce858`, `9416d0d`.
- [x] Task 9 — scoped runtime-vs-CLI instructions and next-owner-turn UI notice. Workspace AGENTS change is a separate narrow diff, not a blanket workspace commit.
- [x] Task 9b — all five unique P1/P2 findings from the single integrated round closed; actual public ROOT_CONVERSATION_ID (Pi 1.3.0 = 1), not a fake root-0 fixture.
- [x] Task 10 / S9 — architecture and product Targeted Closure **PASS**, original FAIL reports retained. One integrated analytical round plus targeted correction acceptance; no second broad review.
- [x] Task 10 / S10–S11 — repository ledger and canonical brain implementation/lesson record linked from project memory.

**Fresh parent evidence:** `accepted-policy-verification.json` in thread `thr_3e4z9meeqs` storage, source candidate `4a3dab9` (production tree identical to `9416d0d`): **395 Node + 9 UI = 404 pass, 0 fail**; typecheck/build/dependencies exit 0; changed production files <200 lines. `bb plugin types --check` remains **exit 1**, a documented dependency-placement deviation, not a green check. SDK is required at runtime under production-only installation.

**Deployment boundary:** version remains 0.2.52; no install, reload, push, tag or release by this cycle, and no live configured-model rollout is claimed. The later user-requested file-change delta micro-loop is a separate scope under `2026-10-25-file-change-delta-micro-loop.md`. Vertex is authorized for remaining helpers because Antigravity quota is exhausted.

## Historical execution baseline (superseded by the checklist above)

**Execution baseline:** User approved implementation in `thr_3e4z9meeqs`. Repository `main`, HEAD `4d02d4c`, version `0.2.52`; 330 baseline tests and `npx tsc --noEmit` pass. Remote is PUBLIC: local commits are allowed, but this task does not authorize public push/tag/release. Installed BB0.47.1 / latest stable SDK0.6.79 confirmed. Task1 is implemented locally in `1deba49` (332 tests pass; root server is typechecked). SDK CLI check reports version match but exits1 on its generic devDependency advice; retain runtime dependency per provider-bridge contract and document this deviation, never label that command PASS. Independent migration review now PASS (`2026-10-25-sdk-migration-review.md`), slice only. Backend Tasks2–3 implemented in `4754427`, independent backend review PASS, parent fresh focused24/full356 tests, tsc and build PASS; one P3 defense-in-depth mapping suggestion is log-only (SDK input contract already validates). After the parent S7 readback, Tasks2–3 are approved as the next bounded slice; Tasks4–5 are approved as one native batch after `2026-10-25-native-policy-seams.md` and parent readback; Tasks6–10 remain pending their seam review. No final S9 PASS has been issued.

**Latest execution instruction (user, 2026-10-25):** Finish remaining functionality first; no more intermediate implementation reviews. Keep TDD/tests/build. Run ONE final integrated review round on the complete remaining implementation, not repeated per-slice reviews. Native/backend/mirror batches are already implemented; finish UI + narrowly selected packaging/contract/instruction cleanup.

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
6. **BB Settings Section UI:** Connected via `manifest.bb.app: "./app.tsx"` and `app.slots.settingsSection`; `experimental_ProviderModelPicker` locked to `pi-durable`; draft vs applied state; disabled picker in inherit mode; initial preview via the existing public sdk.providers.models API without fake model IDs or a custom host RPC; scope clearly labeled as global per plugin/BB server.
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
  - Catalog preview uses EXISTING public `useSdk().providers.models({providerId:'pi-durable', hostId OR environmentId, signal})`; no new server/host bootstrap RPC is needed. SDK0.6.79 dts17595–17633 and SystemExecutionOptionsResponse10428 verified. Use the same route for query and public picker. This supersedes earlier own-host-RPC bootstrap recommendations.
- **Runner Command Type:** `"set_subagent_policy"` with payload `{ policyRecord: SubagentPolicyRecord }`

### Wire DTO Types (`src/policy/types.ts`)
```typescript
export type SubagentPolicyMode = "inherit" | "configured";

// Native type authority; boundary Zod enum must cover this installed Pi1.3 contract.
export type SubagentThinkingLevel = import("@earendil-works/pi-ai").ModelThinkingLevel;

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
  updatedAt?: string;
  policy: SubagentPolicy;
}

export interface SubagentPolicyHolder {
  getRecord(): SubagentPolicyRecord;
  setRecord(record: SubagentPolicyRecord): Promise<void>;
}

export interface ResolvedChildConfiguration {
  model: SubagentModelReference;
  thinkingLevel: SubagentThinkingLevel;
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
- Modify: `server.ts` (required current public SDK calls and factory typing)
- Modify: `tsconfig.json` (include root `server.ts` so SDK boundary is typechecked; old Doctor app remains excluded until replaced by Task8)
- Target: `package-lock.json`, build-generated `dist` metadata/bundles

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
Actual Task1: tests/build/tsc pass; `bb plugin types --check` exits1 with matching0.6.79 versions because its generic devDependency placement rule conflicts with provider-bridge production runtime imports. Retain SDK in dependencies; document the exact exit instead of claiming clean check.

- [ ] **Step 5: Commit migration slice**

```bash
git add package.json package-lock.json tests/package-integrity.test.ts
git commit -m "chore: migrate to @get-bb/plugin-sdk 0.6.79 with engines >=0.47.1"
```

---

### Task 2: Shared Strict Subagent Policy DTOs, Schemas & Pure Resolver Service

**Boundary:** Domain & Validation Boundary.  
**AP Gates:** `AP-011` (Low coupling and high cohesion), `AP-012` (Fail-fast and explicit error contracts), `AP-020` (Clean Architecture boundaries), `AP-022` (Typed errors and preserved causes), `AP-026` (API contracts and DTO boundaries), `AP-028` (Deterministic tests), `AP-050` (Enum semantics).  
**Files:**
- Create: `src/policy/types.ts`
- Create: `src/policy/schema.ts`
- Create: `src/policy/resolver.ts`
- Test: `tests/subagent-policy-schema.test.ts`
- Test: `tests/subagent-policy-resolver.test.ts`

- [ ] **Step 1: Write failing tests for schemas, resolver, boundary mapping, and availability checks**

In `tests/subagent-policy-schema.test.ts`:
- Assert `subagentPolicyRecordSchema` validates valid `inherit` and `configured` shapes.
- Assert rejection of `configured` without `configuredProfile`, unknown keys (`.strict()`), and invalid thinking levels (accepting `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`).
- Assert `subagentPolicySetInputSchema` validates `{ policy, expectedRevision }`.

In `tests/subagent-policy-resolver.test.ts`:
- Resolver signature: `resolveSubagentModelConfiguration(record: SubagentPolicyRecord, parentContext: { model?: SubagentModelReference; thinkingLevel?: SubagentThinkingLevel }, availableModels: readonly Model<Api>[]): ResolvedChildConfiguration`.
- Test inherit mode: uses parent model and thinking level; throws `SUBAGENT_POLICY_INVALID` if parent model missing.
- Test configured mode: matches `configuredProfile.model` against `availableModels: readonly Model<Api>[]`. Validates thinking level via public `getSupportedThinkingLevels(model)` from `@earendil-works/pi-ai/models`.
- Test boundary mapping: BB reasoning level `"none"` ↔ native thinking level `"off"`.
- Test fail-fast unavailability: if model is absent from `availableModels` (unauthenticated/unregistered), throw typed error `SUBAGENT_MODEL_UNAVAILABLE` with actionable UI path (`Settings → Installed plugins → Pi Durable → Subagents`). No silent fallback to parent or first model.
- Test unsupported thinking: if thinking level not in `getSupportedThinkingLevels(model)`, throw `SUBAGENT_POLICY_INVALID`.
- Injected fixed clock in test fixtures; optional `updatedAt`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/subagent-policy-schema.test.ts tests/subagent-policy-resolver.test.ts`  
Expected output: FAIL with module resolution / missing file errors.

- [ ] **Step 3: Implement `src/policy/types.ts`, `src/policy/schema.ts`, and `src/policy/resolver.ts`**

- `src/policy/types.ts`: export `SubagentPolicyMode`, `SubagentThinkingLevel`, `SubagentModelReference`, `SubagentModelProfile`, `SubagentPolicy`, `SubagentPolicyRecord`, `SubagentPolicyHolder`, `ResolvedChildConfiguration`.
- `src/policy/schema.ts`: Zod schemas for all policy types with `.strict()`, strict enum for thinking levels including `"minimal"`, and non-negative integer revisions.
- `src/policy/resolver.ts`: export `resolveSubagentModelConfiguration`. Uses public `getSupportedThinkingLevels` from `@earendil-works/pi-ai/models`. No fictitious `.hasCredentials` or `.reasoningLevels` properties on `Model`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/subagent-policy-schema.test.ts tests/subagent-policy-resolver.test.ts`  
Expected output: PASS (all schema and resolver tests green).

- [ ] **Step 5: Commit policy domain slice**

```bash
git add src/policy/ tests/subagent-policy-schema.test.ts tests/subagent-policy-resolver.test.ts
git commit -m "feat(policy): implement strict policy schemas, DTOs and pure resolver service"
```

---

### Task 3: Policy KV Store & Hydration Service in Server Entry

**Boundary:** Infrastructure Adapter / BB Plugin Storage & RPC Registration.  
**AP Gates:** `AP-012` (Fail-fast error contracts), `AP-013` (User-data integrity), `AP-016` (Trusted execution boundary), `AP-020` (Composition root), `AP-023` (Async discipline), `AP-026` (API contracts), `AP-034` (Explicit concurrency strategy: serialized CAS), `AP-035` (Idempotent commands).  
**Files:**
- Create: `src/policy/store.ts`
- Modify: `src/rpc/contract.ts`
- Modify: `server.ts`
- Test: `tests/subagent-policy-store.test.ts`

- [ ] **Step 1: Write failing tests for SubagentPolicyStore CAS, concurrent updates, and cold hydration**

In `tests/subagent-policy-store.test.ts`:
- Test clean storage: `hydrate()` initializes canonical `inherit` default (`revision: 0`, `mode: "inherit"`).
- Test serialized CAS mutation: `setPolicy(policy, expectedRevision)` writes whole record to KV with incremented revision and updates cache.
- Test failed write leaves cache intact: if `kv.set` rejects, in-memory cache retains prior acknowledged record.
- Test optimistic locking conflict: when `expectedRevision !== current.revision`, throws typed `REVISION_CONFLICT` without updating KV or cache.
- Test concurrent updates: two simultaneous `setPolicy` calls with the same `expectedRevision` produce exactly 1 success and 1 `REVISION_CONFLICT`.
- Test observable corruption: corrupted data or storage read errors in `hydrate()` throw explicit `SUBAGENT_POLICY_LOAD_ERROR` — no silent fallback to inherit.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/subagent-policy-store.test.ts`  
Expected output: FAIL with module not found (`../src/policy/store.ts`).

- [ ] **Step 3: Implement `SubagentPolicyStore`, update `contract.ts` and `server.ts`**

- `src/policy/store.ts`: `SubagentPolicyStore` wrapping current public `bb.storage.kv` with key `"subagent.policy.v1"`. Serialize the entire expectedRevision comparison + persistence + cache update with a failure-resilient promise queue. Update cache only after successful persistence. Return defensive immutable snapshots. Default revision0 record has no timestamp; inject a clock for mutation timestamps and use fixed test time. Derive plain JSON DTO types from the canonical schemas or use type aliases compatible with public JsonValue; no unsafe casts to force providerOptions.
- `src/rpc/contract.ts`: register strict RPC contracts:
  - `subagent_policy_get`: output `{ record: subagentPolicyRecordSchema }`
  - `subagent_policy_set`: input `{ policy: subagentPolicySchema, expectedRevision: z.number().int().nonnegative() }`, output `{ record: subagentPolicyRecordSchema }`
- `server.ts`: async public SDK factory awaits `store.hydrate()` before registering RPC handlers and provider. Pass acknowledged `store.getRecord()` via `deriveProviderOptions(ctx)` into `providerOptions.subagentPolicy`. Map typed errors into the public RPC error transport without losing error code/cause. Add a narrow server startup/persistence contract test: hold KV read pending and assert no provider registration; reject/corrupt and assert no registration; successful get/set changes the next derived snapshot. Adapt existing server-entry test fakes (`package-integrity`, `thinking-presentation`, `master-parity-conformance`) with KV and await async initialization. Do not expose unfinished catalog bootstrap until Task8.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/subagent-policy-store.test.ts`  
Expected output: PASS (all store and concurrency tests green).

- [ ] **Step 5: Commit store and server integration**

```bash
git add src/policy/store.ts src/rpc/contract.ts server.ts tests/subagent-policy-store.test.ts
git commit -m "feat(policy): implement SubagentPolicyStore with optimistic CAS, cold hydration, and RPC contracts"
```

---

### Task 4: Runner Policy Holder Instance & Session Commands Wiring

**Execution batch:** Tasks4–5 execute together, introducing the required extension factory in the same coherent batch as registry injection. No Task4-only broken import commit. Public setter async persistence and native execution ACK restore are required by S7 seam review.

**Boundary:** Runner Process & Session Command Boundary.  
**AP Gates:** `AP-011` (Low coupling), `AP-012` (Fail-fast), `AP-019` (Line budgets), `AP-020` (Clean Architecture), `AP-034` (Instance-scoped concurrency, no global mutable singleton), `AP-035` (Idempotent commands), `AP-038` (Traceability).  
**Files:**
- Create: `src/runner/subagent-policy-state.ts` (instance holder, serialized async persistence)
- Create: `src/runner/subagent-policy-ack.ts` (public native session Doc and load/persist adapter)
- Create: `src/runner/session-state-commands.ts` (bounded read-only get_state/get_session_stats extraction; current dispatcher199 lines)
- Modify: `src/policy/types.ts` (holder setter becomes async)
- Modify: `src/runner/runtime-types.ts`, `src/runner/runtime-loader.ts`, `src/runner/runtime.ts`
- Modify: `src/runner/harness-setup.ts`, `src/runner/session-commands.ts`
- Test: `tests/runner-subagent-policy.test.ts`; add native ack restore/failed-persist/concurrency/startup tests

- [ ] **Step 1: Write failing tests for instance-scoped policy holder and runner commands**

In `tests/runner-subagent-policy.test.ts`:
- Test holder instance isolation: two independent holders created via `createSubagentPolicyHolder()` maintain separate records without shared module state.
- Test monotonic revisions: an identical same-revision snapshot is acknowledged idempotently; a different payload at the same revision is `REVISION_CONFLICT`; a lower revision is rejected. A fresh holder can accept initial revision0 inherit without timestamp, matching the store default.
- Test `handleActiveSessionCommand`: command `set_subagent_policy` validates payload, updates `durable.subagentPolicyHolder`, and responds success before prompt execution.
- Test `get_state`: when `cmd.conversationId` targets a child conversation, read state for that conversation instead of root.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/runner-subagent-policy.test.ts`  
Expected output: FAIL with module not found or missing property errors.

- [ ] **Step 3: Implement `subagent-policy-state.ts` and modify runner integration files**

- `src/runner/subagent-policy-state.ts`: export `createSubagentPolicyHolder({ initialRecord, persist }): SubagentPolicyHolder`. Required narrow async persistence callback. Setter validates shape, serializes comparison + native persistence + cache update, rejects downgrade / same-revision different payload; identical replay is a no-write success. Failed persistence leaves last acknowledged snapshot intact, queue recovers. Getter returns defensive snapshot. No mutable module singleton.
- `src/runner/subagent-policy-ack.ts`: public `defineDoc` session-scope `SubagentPolicyAckDoc`, kind `bb.subagent-policy-ack`, version1, initial nullable record. Export `loadSubagentPolicyHolder(harness)` to restore last execution ACK and bind native `harness.commit(tx => tx.doc(...))` persistence. BB KV remains sole user configuration authority; native doc is only the previously acknowledged execution checkpoint.
- `src/runner/runtime-loader.ts`: registry is built BEFORE Harness.open. Inject a narrow getter closure over this instance's holder; if invoked before initialization, explicitly reject, do not silently inherit. Once Harness.open returns (paused), load/validate the native ACK and construct holder before returning `LoadedHarnessEnvironment`; expose holder there. New/no-ACK sessions get canonical revision0 inherit without timestamp.
- `src/runner/runtime.ts`: expose holder in returned `OpenDurableResult`; restoration MUST finish before existing `harness.resume()` so persisted owner jobs never admit a child under a temporary default. Do not delay/background-redesign resume or Anchor ownership.
- `src/runner/harness-setup.ts`: add REQUIRED policy getter before optional arguments to `createCodingRegistry`; migrate all callsites. Install `createSubagentExtension(getPolicy)` with stable extension name, not a global compatibility instance.
- `src/runner/session-state-commands.ts`: extract read-only state/stats handler using existing binding-handler pattern. Child get_state calls public `harness.conversation(targetId).agent(ctx)` without changing root/current selection.
- `src/runner/session-commands.ts`: typed policyRecord payload; await holder.setRecord then respond success. Failed schema/revision/persistence yields coded actionable error, never success. Dispatcher stays <200 lines.
- Native ACK tests must cover process-like close/reopen restoration BEFORE resume, failed-commit cache consistency, concurrent incoming revisions, idempotent retry, and separate-runtime isolation.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/runner-subagent-policy.test.ts`  
Expected output: PASS (all runner command and holder tests green).

- [ ] **Step 5: Commit runner policy holder slice**

```bash
git add src/runner/subagent-policy-state.ts src/runner/runtime-types.ts src/runner/runtime-loader.ts src/runner/harness-setup.ts src/runner/session-commands.ts tests/runner-subagent-policy.test.ts
git commit -m "feat(runner): implement instance-scoped SubagentPolicyHolder and wire set_subagent_policy command"
```

---

### Task 5: Native Subagent Tool: Validation, Replay Safety & Role Separation

**Boundary:** Runner Execution & Pi Durable Harness Integration.  
**AP Gates:** `AP-010` (Thin Adapter), `AP-011` (High cohesion), `AP-012` (Fail-fast validation), `AP-020` (SRP), `AP-026` (Replay safety & contracts), `AP-027` (Validated configuration), `AP-028` (Deterministic tests with real SDK fixture).  
**Files:**
- Create: `src/runner/subagent-role.ts`
- Modify: `src/runner/subagent.ts`, `src/runner/subagent-docs.ts`
- Test: `tests/subagent-native-model-application.test.ts`
- Migrate existing native fixtures in `subagent-auto-spawn`, `subagent-courier-delivery`, `durable-subagent`, `codemode-canonical-routines`, `subagent-error-handling`, `subagent-async-envelope` tests as needed (explicit factory/getter and registered available fixture model). No production compatibility singleton.

- [ ] **Step 1: Write failing tests for neutral role envelope, real SDK model resolution, and replay safety**

In `tests/subagent-native-model-application.test.ts`:
- Test role envelope: `buildTechnicalWorkerRole()` returns static technical envelope; does NOT interpolate task text into system instructions; does NOT ban git archaeology.
- Real SDK fixture setup: register valid test provider and model on `createModels()`.
- Test configured execution: fetches `availableModels` via native `api.models.getAvailable()` outside `api.commit`, resolves via pure resolver, creates child conversation, and applies `configure(tx, child.id, { model, thinkingLevel, instructions })`. Parent `AgentDoc` is untouched.
- Test missing/uncredentialed model fail-fast: if configured model is unregistered or uncredentialed, execution fails BEFORE child creation with typed `SUBAGENT_MODEL_UNAVAILABLE` error (no fallback).
- Test replay safety: when `SubagentsDoc` already has an entry for the task, reuses existing conversation handle and existing reporter; does NOT recreate `DefaultReporter` or reconfigure child.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/subagent-native-model-application.test.ts`  
Expected output: FAIL with missing role helper or configuration mismatch.

- [ ] **Step 3: Implement `subagent-role.ts` and modify `subagent.ts`**

- `src/runner/subagent-role.ts`: export `buildTechnicalWorkerRole(): string`. Static technical boundaries only.
- `src/runner/subagent.ts`:
  - Export `createSubagentExtension(getPolicy: () => SubagentPolicyRecord): Extension`.
  - Replay guard first: check `tx.doc(SubagentsDoc, api.conversationId)`. If existing child exists for task, reuse existing record and reporter.
  - New logical child admission begins after existing-child lookup. Outside `api.commit`, read parent agent and capture one immutable latest acknowledged `getPolicy()` snapshot. Configured mode obtains available models with public `api.models.getAvailable()`; inherit mode may directly copy the validated parent profile without an unnecessary auth/catalog probe. Resolve through `resolveSubagentModelConfiguration(record, parentContext, availableModels)` before creation. Freeze that snapshot for this admission (including any async validation); no remote/catalog I/O inside durable transaction. No availability checks/reconfiguration for a reused child.
  - Inside `api.commit`: rescan ownership before create, preserve existing SubagentsDoc record/reporter, create at most one task-owned child, configure with resolved model/thinking and `buildTechnicalWorkerRole()`. Extend `SubagentRecord` with `actualModel`, `thinkingLevel`, `source: ResolvedChildConfiguration["source"]`, `policyRevision`; preserve optional historical-record fields without reconfiguration.
  - Emit the same actual profile/source/revision in `api.details` and final tool details for mirror observability. Task is user input only, never interpolated into role envelope.
  - Migrate internal tests/callers to explicit factory injection. Do NOT retain `export const Subagent = ...default inherit...` as a legacy fixture shim; no hidden bypass of saved policy. Update registry setup tests with required getter.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/subagent-native-model-application.test.ts`  
Expected output: PASS (configured child created with correct model/thinking, replay preserved).

- [ ] **Step 5: Commit native subagent execution slice**

```bash
git add src/runner/subagent-role.ts src/runner/subagent.ts tests/subagent-native-model-application.test.ts
git commit -m "feat(runner): configure native child model from policy with replay safety and role separation"
```

---

### Task 6: Host Reconcile, ProviderOptions Delivery & Root Bridge Guard

**Boundary:** Host Session Options & Provider Bridge Router.  
**AP Gates:** `AP-011` (High cohesion), `AP-016` (Trusted boundary: root vs mirror), `AP-019` (Line budgets < 200), `AP-020` (SRP), `AP-022` (Typed errors: `CHILD_MODEL_POLICY_LOCKED`), `AP-028` (Test determinism).  
**Files:**
- Modify: `src/host/session-reconcile.ts`, `src/host/bridge-router.ts`, `src/host/session.ts`
- Modify: `src/host/session-registry.ts`, `src/host/subagent-mirror.ts`, `src/host/subthread-spawner.ts`
- Create narrow `src/host/child-turn-guard.ts` and/or `session-owner.ts` if needed to keep touched files <200 lines
- Test: `tests/host-subagent-policy-delivery.test.ts`, `tests/subagent-mirror-guard.test.ts`
- Test warm/cold owner identity, non-native CLI child isolation, profile forwarding and actual follow-ups

- [ ] **Step 1: Write failing tests for root turn delivery and child mirror isolation**

In `tests/host-subagent-policy-delivery.test.ts`:
- Test that root thread turn with changed `providerOptions.subagentPolicy` calls `session.setSubagentPolicy(record)` which dispatches `set_subagent_policy` command to runner.
- Test first desired configured snapshot is sent even when already present in session.options, including absent params.options / top-level providerOptions. ACK revision starts undefined, separate from desired; wait for runner success before caching ACK and before prompt. Failed ack leaves prior cache and sends no prompt.
- Test changed revision is acknowledged before prompt; identical ACK isn't resent unnecessarily.

In `tests/subagent-mirror-guard.test.ts`:
- Test that child mirror turn (`params.threadId !== session.options.threadId`) NEVER calls `reconcileSessionOptions` on root session, and NEVER mutates root session model, thinking, or policy.
- Test that child mirror turn attempting to override model with a different model fails with typed RPC error `-32602` (`CHILD_MODEL_POLICY_LOCKED`).
- Test child thinking override is rejected too; native off and BB none are equivalent. Different child CWD and child compaction may not close/reopen/compact shared root: reject unsupported child context operations explicitly.
- Test child follow-ups target correct conversation and run exactly once, including text with original task prefix and empty/completed metadata: do not discard them as another initial admission.
- Cold mirror test: with no active parent but a known native child composite ID/binding + parent thread, reopening must preserve physical root identity and omit child model/thinking from root runner CLI. Child can never become root owner merely because it opened first.
- Non-native CLI child with different native session key and no native child binding/admission must remain independent; do not share a root merely due to parentThreadId.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-subagent-policy-delivery.test.ts tests/subagent-mirror-guard.test.ts`  
Expected output: FAIL with missing method / unhandled mirror mutation.

- [ ] **Step 3: Update `session-reconcile.ts`, `bridge-router.ts`, and `session.ts`**

- `session-reconcile.ts`: typed required setter and separately tracked acknowledged revision. Desired record can come from incoming owner options or initial session.options; validate the canonical schema, send first/changed policy and await ACK before prompt. No optional new-method probes or any casts.
- `session.ts`: send typed set_subagent_policy; update ACK snapshot/revision only after requestOk success. Native ACK restoration already protects resumed jobs; only OWNER turns deliver a newer setting.
- `bridge-router.ts`: determine actual owner/target BEFORE reconcileCwd and compaction branches, not only before model reconciliation. Child start/steer bypass all root options/CWD/model/thinking/policy mutation; reject true model/thinking/context overrides with actionable JSON-RPC -32602. Targeted get_state from Task4 is the fallback when actual child metadata is absent. Refuse unresolved owner rather than guess.
- `session-registry.ts`: preserve known root thread/session identity on cold child reconnect; child composer model/thinking must not be passed as root CLI arguments (openDurable would configure root). Existing parent metadata/composite/binding sources only, no new private DB queries. Shared-owner reuse requires known native child admission/binding (or actual owner alias), not arbitrary manual CLI parenthood. Keep alias release ownership correct; no phantom permanent root lease.
- `subagent-mirror.ts` records actualModel/thinking/source/revision from native details. `subthread-spawner.ts` passes explicit actual native --model and --reasoning-level to BB mirror, normalizing off/none. It remains a mirror, never starts another native generation; no hardcoded user model.
- Initial mirror admission suppression is one-shot and nonempty/task-specific; real subsequent inputs—including same-prefix text—are routed, not swallowed. Do not invent a new graph DSL or redesign Anchor.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-subagent-policy-delivery.test.ts tests/subagent-mirror-guard.test.ts`  
Expected output: PASS (all root delivery and mirror guard tests green).

- [ ] **Step 5: Commit host reconcile and bridge guard**

```bash
git add src/host/session-reconcile.ts src/host/bridge-router.ts src/host/session.ts tests/host-subagent-policy-delivery.test.ts tests/subagent-mirror-guard.test.ts
git commit -m "feat(host): reconcile subagent policy on root turn and isolate root session from child mirrors"
```

---

### Task 7: Host Subagent Lifecycle Extraction, Accurate Outcome States & Early Ack Fix

**Boundary:** Host Session Lifecycle & Subagent Mirror Management.  
**AP Gates:** `AP-012` (Accurate error contracts), `AP-013` (Data integrity), `AP-019` (Line budgets: `session.ts` < 200 lines), `AP-020` (SRP), `AP-026` (Lifecycle semantics), `AP-050` (Status semantics).  
**Files:**
- Create: `src/host/session-subagent-handler.ts` (bounded extraction from session.ts)
- Modify: `src/host/session.ts`, `src/host/subagent-mirror.ts`, `src/host/bridge-router.ts`
- Modify: `src/runner/bridge/bb-child-event-adapter.ts`, `src/runner/subagent-watcher.ts`
- Create bounded `src/runner/bridge/child-run-outcome.ts` if needed to keep child adapter <200 lines
- Test: `tests/subagent-lifecycle-fixes.test.ts`, native child batch-outcome tests and late-binding dedup scenarios

- [ ] **Step 1: Write failing tests for background spawn acknowledgment and accurate termination states**

In `tests/subagent-lifecycle-fixes.test.ts`:
- Test background tool ack: `tool_execution_end` for `subagent` with `background: true` is an admission acknowledgment; subagent MUST remain in `running` status.
- Foreground tool result settles only after actual input answer; error must not be labeled success.
- Native Pi1.3 run_end contains ONLY inputs, no stopReason. Use actual publication order fixtures: `[run_end, submission(unanswered, reason: aborted)]` -> wire aborted -> interrupted; unanswered failure -> failed; `[tool task_failed, run_end, submission(done)]` -> completed (successful input wins over recoverable tool failure).
- Child adapter pre-scans the full batch before translating run_end, correlating its input IDs with terminal submission receipts. Reset per-run faults; do not invent native stopReason fields or permanently classify every tool error as run failure.
- Bound mirror receives exactly one translated terminal boundary with actual completed/failed/interrupted status; remove session.ts hardcoded duplicate completed emission.
- Completion BEFORE mirror binding must buffer/replay the same authoritative outcome exactly once. The bridge-router completed-initial branch may not synthesize a second hardcoded completed boundary after registerThread already flushed it.
- Background spawn acknowledgment stays running; actual child settlement (not root tool end) closes it. Preserve Anchor/task ownership and cancellation; no speculative Anchor redesign.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/subagent-lifecycle-fixes.test.ts`  
Expected output: FAIL with premature completion assertion failure.

- [ ] **Step 3: Extract `session-subagent-handler.ts` and update `session.ts`**

- `BBChildEventAdapter.handleBatch` (or a narrow outcome helper) pre-scans typed public AgentEvent submissions/task receipts before emission; `subagent-watcher` feeds whole child batches while retaining nested-child discovery. Emit existing typed wire aborted/error fields and errorMessage; native successful input maps to normal completion.
- `session-subagent-handler.ts`: extract scoped event/lifecycle/mirror handling. Background tool ack never closes child. Forward child terminal through child translator once; cache actual terminal outcome for late binding and deduplicate synthesized/replayed terminal delivery.
- `session.ts`: delegates focused lifecycle handling and remains <200 lines including new policy setter. No duplicate hardcoded boundary; no root-turn leakage from child events.
- `subagent-mirror.ts` and `bridge-router.ts`: preserve actual terminal status/result across early settlement, registration flush and admission acknowledgment. One authoritative replay path; no fake completed overwrite or swallowed follow-up.

- [ ] **Step 4: Run tests to verify they pass and check line budget**

Run:
```bash
node --test tests/subagent-lifecycle-fixes.test.ts
wc -l src/host/session.ts src/host/session-subagent-handler.ts
```
Expected output: PASS (all tests pass, `src/host/session.ts` < 200 lines, e.g. ~165 lines).

- [ ] **Step 5: Commit lifecycle fixes and session modularization**

```bash
git add src/host/session-subagent-handler.ts src/host/session.ts src/host/subagent-mirror.ts tests/subagent-lifecycle-fixes.test.ts
git commit -m "fix(host): prevent premature completion on background spawn ack and extract session-subagent-handler"
```

---

### Task 7b: Narrow Packaging / Canonical Command Cleanup

- Evidence: dist/runner grew131161 ->897640 bytes because new policy schema imported Zod and scripts/build-runner.mjs did not externalize it; compiled artifact contains all Zod locales (~20k generated lines). Zod is already a production dependency.
- RED packaging test uses an isolated temporary fixture with a COPY of the actual production build script, a small Zod-importing entry, and node_modules symlink; assert resulting fixed fixture stays small and its exported schema still works. No shared dist writes or fake source grep.
- Minimal fix: externalize zod in existing runner build configuration; do not replace the build system, remove validation, or add a framework. GREEN test + full build; measure actual runner byte reduction.
- Canonical runner control command accepts policyRecord only: remove `(cmd as any).policy` fallback and casts, parse unknown input through canonical schema. RED legacy-body rejection test, then GREEN; no per-call model options.
- Preserve original commits; only owned artifacts regenerated. No release/install.

### Task 8: BB Settings UI via Existing Public Catalog API

**Boundary:** UI Component & Settings Section Slot Boundary.  
**AP Gates:** `AP-010` (Thin Adapter), `AP-011` (Input validation), `AP-019` (Line budgets), `AP-020` (SRP), `AP-021` (Thin entry points), `AP-026` (DTOs), `AP-027` (Configuration fail-fast).  
**Files:**
- Create: `src/ui/settings-subagent-section.tsx`, small profile codec and bounded policy/preview hooks as needed (<200 lines each).
- Reuse public sdk.providers.models and existing get/set RPC; NO new host contract, host entry modification, server proxy or custom catalog lifecycle.
- Modify src/host/catalog.ts only to use public native getSupportedThinkingLevels for reasoning capabilities; server capabilities admit native levels including minimal. No catalog rewrite.
- Modify app.tsx, tsconfig.json, package.json/lock (bb.app and necessary DEV-only React/DOM/tsx test peers; exact SDK/Pi pins unchanged).
- Tests: executed SDK app collector plus actual TSX interactions under tests/ui using public testing/app loadPluginApp/renderSlot. npm test keeps baseline Node tests and adds UI tests.

- [ ] **Step 1: Write failing tests for UI settings contracts, manifest, and host catalog bootstrap**

In `tests/ui-settings-contract.test.ts`:
- Assert `package.json` defines `"bb": { "app": "./app.tsx" }`.
- Execute the public definePluginApp collector to assert a settingsSection registration OBJECT and no old Doctor mount; do not substitute source-regex tests.
- Public SDK testing/app + real React mount exercises draft vs applied, explicit Save, disabled inherit picker, configured validation, conflict/refetch preserving draft, persistence error/retry and saving state.
- Empty/offline catalog creates NO fake picker value and does not write a profile; switching to inherit can still be saved without catalog availability.
- Route changes do not reset draft or accept stale async responses. Configured Save disabled while current-route catalog is loading/unavailable or model/thinking invalid. Retain unavailable saved profile with clear warning—never replace it automatically.
- Query exact public sdk.providers.models({providerId:'pi-durable',hostId OR environmentId,signal}); test route consistency, cancellation/stale responses and modelLoadError. SDK owns environment/host routing; do not implement another proxy.
- Model/level preview comes from existing provider catalog; native getSupportedThinkingLevels remains capability authority. Preview never persists.
- Public SDK dts17595–17633 and10428 provide the simpler catalog API missed in the earlier seam report; it supersedes that report's custom host-RPC recommendation.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ui-settings-contract.test.ts`  
Expected output: FAIL with missing manifest entry or contract mismatch.

- [ ] **Step 3: Implement host catalog bootstrap, settings section component, and update `app.tsx`**

- Use existing public providers.models through useSdk: args are a union of {providerId:'pi-durable',hostId,signal} OR {providerId:'pi-durable',environmentId,signal}. Result SystemExecutionOptionsResponse exposes models[], modelLoadError and provider metadata. Query with AbortSignal; ignore obsolete responses. No own host RPC/proxy/process lifecycle.
- Public browser system.config() gives primaryHostId, hosts.list() gives Host[], environments.list() gives Environment[]. These selectors are catalog PREVIEW only; policy remains global. Do not silently substitute another machine for a selected offline primary. Picker routing and models query must address the same host/environment.
- Existing ModelCatalog thinking efforts must be generated from public getSupportedThinkingLevels, mapped off->none, rather than independent hardcoded six-level filtering. Provider capabilities/labels admit the native levels, including minimal. No custom catalog/model identifiers.
- UI mounts shared experimental_ProviderModelPicker with concrete value `{providerId:'pi-durable',model,reasoningLevel}` and allowProviderChange=false; there is NO top-level providerId prop. Use saved profile if present, otherwise genuine catalog default PREVIEW only. If no real value, render empty/error state, not a fake ID.
- Separate applied record and mutable draft; explicit Save with expectedRevision. Disabled picker in inherit with explanatory copy, but inherit Save works without a catalog and retains optional configured profile. Configured Save validates current-route model/level. Disable policy mutations during saving or otherwise preserve edits made during save.
- SDK conflict refusal code is conflict; refetch applied record/revision but preserve draft and require explicit retry. Storage/offline errors retain draft; clear loading state. Never auto-persist an initial preview or replace unavailable saved profile.
- `app.tsx`: definePluginApp(app => app.slots.settingsSection({id:'subagent-model-policy',title:'Субагенты',component:SubagentSettingsSection})). This replaces old Doctor body; manifest bb.app='./app.tsx'. Include root app/new TSX in typechecking.
- Install only necessary DEV test peers, keep native/SDK exact pins. Add test:ui via tsx + jsdom/public SDK testing/app; npm test runs baseline Node tests PLUS UI tests. Real interactions, not source grep. Touched modules/new test files remain <200 lines.

- [ ] **Step 4: Run tests, typecheck and verify UI build**

Run:
```bash
node --test tests/ui-settings-contract.test.ts
bb plugin types --check
npm run build
```
Expected output: PASS (tests pass, types check succeeds, bundle built cleanly).

- [ ] **Step 5: Commit settings UI and manifest update**

```bash
git add package.json app.tsx src/host/index.ts src/rpc/contract.ts src/ui/ tests/ui-settings-contract.test.ts
git commit -m "feat(ui): add SubagentSettingsSection with experimental_ProviderModelPicker and manifest app entry"
```

---

### Task 9: Instruction Docs Scoping & Thin Adapter Clarification

**Boundary:** Workspace Documentation & Repository Operating Contract.  
**AP Gates:** `AP-010` (Thin Adapter), `AP-020` (SRP), `AP-026` (Boundary contracts).  
**Files:**
- Modify: `AGENTS.md` (local repo)
- Test: `tests/instructions-conformance.test.ts`

- [ ] **Step 1: Write failing test for repo instruction conformance**

In `tests/instructions-conformance.test.ts`:
- Assert `AGENTS.md` explicitly documents Thin Adapter technical role envelope permissions.
- Assert `AGENTS.md` scopes coordinator rules to root orchestrator, leaving subagents as task workers governed by runtime policy.
- Assert `AGENTS.md` contains no hardcoded model name requirements for subagents.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/instructions-conformance.test.ts`  
Expected output: FAIL.

- [ ] **Step 3: Update local `AGENTS.md`**

In `AGENTS.md`:
- Clarify that minimal technical role envelope in `subagent-role.ts` is an authorized tool contract, while core system prompt remains upstream `@earendil-works/pi-coding-agent`.
- Clarify coordinator vs worker distinction: root thread coordinates, while subagents execute bounded briefs under runtime subagent policy.
- Remove prompt-duplicated model references.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/instructions-conformance.test.ts`  
Expected output: PASS.

- [ ] **Step 5: Commit instruction updates**

```bash
git add AGENTS.md tests/instructions-conformance.test.ts
git commit -m "docs(arch): clarify thin adapter role contract and coordinator-only scoping in AGENTS.md"
```

---

### Task 9b: Corrections from the Single Integrated Review

Candidate reviewed: `53c6c6b`. Reports: `2026-10-25-subagent-policy-final-architecture.md` and `2026-10-25-subagent-policy-final-product.md` in `docs/arch-improvement/reviews/`.

Selected fix-now items (one bounded remediation batch, no new broad review round):
- [P1] Cold child profile guard: decode the actual flat get_state response (model/thinkingLevel), remove unsupported state.agent/agent aliases and production any. If a requested override cannot be validated, return an explicit error; never fall back to root/defaults.
- [P1] Distinguish native child mirrors from independent manual BB children. Known physical session owner identity and native conversation/binding win over mere BB parentThreadId. Re-evaluate after session creation; independent root receives policy/reconcile and compaction, native child still cannot mutate shared root.
- [P2] Save must not erase edits made during the pending request. Disable mode radios while saving and preserve a changed draft when handling a delayed response.
- [P2] Actually abort stale catalog queries on route change/unmount; invalidate current-route readiness immediately so old results cannot enable Save.
- [P2] Remove synthetic hostId='default' and old-SDK feature probes. Call current mandatory SDK APIs; no real target means routing=null, an honest empty/error state and no model query. Inherit remains saveable.
- [P3, fix-now] Scope the remaining workspace model prohibition explicitly to CLI fallback. Add clear UI copy that saved policy applies to new admissions from the next owner turn; existing children are unchanged.
- [P3, log-only] A single general UI error panel is acceptable for this release; do not expand into unrelated styling/layout work.

For each selected behavior: add a failing regression first, capture RED, make the minimal correction and capture GREEN. Reuse public SDK app tests and actual runner DTOs. Parent reproduction for the two host errors is in `final-parent-host-repro.json` in this thread's storage; reports and this repository plan are canonical operational records.

After the batch: full Node + UI tests, typecheck, build, dependency/version check and packaging size check. Close the original findings with targeted evidence in the same review records; do not start another full analytical round. No publication, live installation or reload.

### Task 10: Integrated Verification and Repository Closeout

**Boundary:** Quality Verification Gate & Handover.  
**AP Gates:** Full AP-010..AP-071 gates.  
**Files:**
- Canonical artifact: `docs/superpowers/plans/2026-10-25-subagent-model-policy.md`
- Existing cycle records: `docs/arch-improvement/ledger.md` and `docs/arch-improvement/memory.md`

- [ ] **Step 1: Run complete repository verification suite**

Run:
```bash
npm test
bb plugin types --check
npx tsc --noEmit
npm run build
```
Executed result: tests/typecheck/build pass. SDK CLI confirms version but exits 1 on generic devDependency placement advice; keep the necessary runtime dependency and record this exception explicitly.

- [ ] **Step 2: Blackbox public RPC and native model smoke verification**
  - Verify RPC get/set (including conflict) and public sdk.providers.models catalog query with explicit routing; no custom bootstrap RPC.
  - Verify native model application: inherit resolves parent model, configured resolves target model, unauthenticated fails fast before child creation.
  - Verify no live plugin reload or public push/tag/release without parent decision.

- [ ] **Step 3: Dual-circuit verification (S9 Gate, not proposal/S7 review)**
  - Circuit 1: Architectural Review (`arch-rules-implementation-review`) checking AP-010..AP-071 and line budgets.
  - Circuit 2: Product Review (`arch-improvement-product-review`) checking inherit/configured journeys, error messages, and UX expectations.

- [ ] **Step 4: S10/S11 durable closeout in repository**
  - Update this canonical repository plan's checkboxes with actual evidence and unresolved items.
  - Append the cycle to `docs/arch-improvement/ledger.md`; record a durable lesson (or explicit none) in `docs/arch-improvement/memory.md`.
  - Reports must reference the repository plan; never hand off an internal thread-storage draft as the working plan.
  - Signal implementation evidence to parent orchestrator (`thr_3e4z9meeqs`); no full completion claim before BOTH final reviewers PASS.

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
   **Mitigation:** Async server factory awaits `store.hydrate()` before registering provider and RPC. Failed reads throw observable `SUBAGENT_POLICY_LOAD_ERROR` rather than falling back to inherit.
2. **Risk:** Host/runner concurrency when user updates policy mid-turn.  
   **Mitigation:** Policy update is monotonic and delivered on next owner/root turn boundary. Runner acknowledges command before prompt/steer submission. Each child admission snapshot is immutable.
3. **Risk:** Missing model credentials on secondary machine.  
   **Mitigation:** Pure resolver throws typed `SUBAGENT_MODEL_UNAVAILABLE` with actionable UI path ("Settings → Installed plugins → Pi Durable → Subagents"), non-retryable.
4. **Risk:** Background subagent completion race with mirror registration.  
   **Mitigation:** Task 7 strictly disallows `tool_execution_end` from completing background subagents, relying on child `agent_end` or task settlement.
5. **Risk:** Line budget regression in `src/host/session.ts` (currently 240 lines).  
   **Mitigation:** Task 7 extracts `session-subagent-handler.ts` (~90 lines), reducing `session.ts` to ~165 lines, cleanly complying with AP-019 (< 200 lines).

---

## 8. S7 Critical Corrections Resolution

Planner amendments address the following review items, but transport failure prevented its final report. The parent read the saved file critically: Tasks2–3 are approved after the corrections above. Future Task4 native wiring order and idempotence, Task7 real terminal-event/status semantics, and Task8 actual public picker props + host route + UI behavior tests must be seam-reviewed before those slices run. The table describes intended resolutions, not a blanket S7 or final S9 PASS:

| Review Item | Priority | Plan Resolution |
|---|---|---|
| Runner policy holder scoped per durable runtime instance | P1 | Task 4: `createSubagentPolicyHolder()` per `openDurable`, exposed on `OpenDurableResult`, getter injected into registry; no module-global singleton. |
| Native execution calls validated pure resolver, real public APIs | P1 | Task 2 & 5: resolver takes `availableModels: readonly Model<Api>[]`, validates via `getSupportedThinkingLevels(model)`, native tool calls `api.models.getAvailable()` outside `commit`. No fictitious `.hasCredentials` or `.reasoningLevels`. |
| Real SDK integration fixture registers valid test provider/model | P1 | Task 5: fixture registers valid model on `createModels()`; asserts uncredentialed/unregistered model fails before child creation without fallback. |
| Monotonic revisions, reject downgrade/same-revision, validate shape | P2 | Task 3 & 4: strict schema validation, monotonic revision rejection in holder and CAS store, optimistic conflict handling without losing draft. |
| Catalog preview through the existing public SDK | P2 | Superseded seam proposal: Task 8 uses sdk.providers.models directly. No subagentCatalogBootstrap RPC, host contract, proxy or independent catalog lifecycle was implemented. |
| Thinking enum derives from Pi 1.3 contracts, mapped at BB boundary | P2 | Task 2: canonical `SubagentThinkingLevel` includes `"minimal"`, BB `"none"` ↔ native `"off"` mapped at boundary. |
| Store mutations serialize CAS + persist + cache update | P2 | Task 3: single-writer queue, cache updated only after successful KV persistence, failed writes leave old cache intact, concurrent test (1 winner). |
| Typed DTOs, no production `any` or optional current method probes | P2 | Tasks 2–8: strict Zod schemas, exact types, no production `any`, removal of deprecated probes. |
| Normative AP identifiers matching `/Users/vanya/Projects/arch-rules/arch-rules.md` | P2 | Header Context Map and all Tasks 2–10 use exact normative baseline AP rule names. |

