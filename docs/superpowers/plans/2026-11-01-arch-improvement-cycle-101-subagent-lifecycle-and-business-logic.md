# Cycle 101: Sovereign Subagents & Anti-Fragile Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all critical business logic and subagent lifecycle defects (3x P0, 6x P1, 1x P2: BL-01..BL-10) discovered in audit thr_nzuzxj3a5u, ensuring subagents launch reliably in Beyond Boundaries with zero layer boundary leaks and 100% test pass rate.

**Architecture:** Ports & Adapters (Hexagonal Architecture) with strict layer firewall isolation between Host (`src/host/`), Runner (`src/runner/`), Domain (`src/runtime-graph/`), Contracts (`src/contracts/`), and Shared (`src/shared/`). All model references are canonicalized through a pure shared domain normalizer (`src/shared/model-ref.ts`), eliminating prefix desyncs across CLI and RPC boundaries. Session lock contention fails closed without destructive process termination.

**Tech Stack:** TypeScript, Node.js (`node:test`, `node:sqlite`), `@earendil-works/pi-durable`, `@earendil-works/chord`, Zod.

**Layer Boundary Firewall Invariant:** Every single task MUST run `node scripts/verify-layer-boundaries.mjs` to ensure 0 imports between `src/runner/` and `src/host/`.

---

## File Structure & Module Responsibilities

- **`src/shared/model-ref.ts`** (NEW): Pure domain utility for normalizing model references: parsing `{ provider, id }` vs `{ provider, modelId }`, stripping redundant `provider/` prefixes, and generating canonical CLI / catalog keys.
- **`src/policy/resolver.ts`** (MODIFY): Subagent model configuration resolution for `inherit` and `configured` modes using `normalizeModelReference`.
- **`src/runner/subagent.ts`** (MODIFY): Subagent tool definition, extracting parent model cleanly with fallback to default settings when unconfigured.
- **`src/host/subthread-spawner.ts`** (MODIFY): CLI argument generation for `bb thread spawn`, passing canonical `--model provider/cleanModelId` without prefix duplication.
- **`src/host/child-turn-guard.ts`** (MODIFY): Turn model policy validation using normalized model IDs, preventing false `CHILD_MODEL_POLICY_LOCKED` rejections.
- **`src/runner/session-storage.ts`** (MODIFY): Safe lock acquisition without destructive `SIGTERM` on live foreign runner processes.
- **`src/runner/subagent-courier.ts`** (MODIFY): Rotating `requestId` on retried delivery to prevent permanent unanswered submission loops.
- **`src/host/session-registry.ts`** & **`src/host/bridge-router.ts`** (MODIFY): Cascading abort of child subagent conversations upon parent thread stop.
- **`src/host/session-subagent-handler.ts`** (MODIFY): Explicit notification delta to parent thread on child spawn failure.
- **`src/host/diagnostics.ts`** (MODIFY): Deferring default model availability check in `doctor.mjs` until after extension initialization.
- **`src/runner/runtime-graph-source.ts`** & **`src/runner/task-labels.ts`** (MODIFY): Bounded LRU sliding windows for task started timestamps and name registries.

---

### Task 1: Canonical Model Reference Normalizer (BL-01, BL-02, BL-05, BL-07)

**Files:**
- Create: `src/shared/model-ref.ts`
- Test: `tests/model-ref-normalization.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/model-ref-normalization.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelReference, formatModelCliArg } from "../src/shared/model-ref.ts";

test("normalizeModelReference handles { provider, modelId } and { provider, id }", () => {
	assert.deepEqual(
		normalizeModelReference({ provider: "antigravity", modelId: "gemini-3.8-flash" }),
		{ provider: "antigravity", modelId: "gemini-3.8-flash" },
	);
	assert.deepEqual(
		normalizeModelReference({ provider: "antigravity", id: "gemini-3.8-flash" }),
		{ provider: "antigravity", modelId: "gemini-3.8-flash" },
	);
});

test("normalizeModelReference strips redundant provider prefix from modelId", () => {
	assert.deepEqual(
		normalizeModelReference({ provider: "antigravity", modelId: "antigravity/gemini-3.8-flash" }),
		{ provider: "antigravity", modelId: "gemini-3.8-flash" },
	);
	assert.deepEqual(
		normalizeModelReference({ provider: "openrouter", id: "openrouter/google/gemini-2.5-flash" }),
		{ provider: "openrouter", modelId: "google/gemini-2.5-flash" },
	);
});

test("formatModelCliArg generates single clean provider/modelId argument", () => {
	assert.equal(
		formatModelCliArg({ provider: "antigravity", modelId: "antigravity/gemini-3.8-flash" }),
		"antigravity/gemini-3.8-flash",
	);
	assert.equal(
		formatModelCliArg({ provider: "antigravity", modelId: "gemini-3.8-flash" }),
		"antigravity/gemini-3.8-flash",
	);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/model-ref-normalization.test.ts`
Expected: FAIL (Cannot find module `../src/shared/model-ref.ts`)

- [ ] **Step 3: Implement minimal code**

Write `src/shared/model-ref.ts`:
```ts
export interface NormalizedModelRef {
	provider: string;
	modelId: string;
}

export function normalizeModelReference(raw: unknown, defaultProvider?: string): NormalizedModelRef | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const provider = typeof r.provider === "string" && r.provider.trim() ? r.provider.trim() : defaultProvider?.trim();
	const rawId = typeof r.modelId === "string" && r.modelId.trim()
		? r.modelId.trim()
		: typeof r.id === "string" && r.id.trim()
			? r.id.trim()
			: undefined;

	if (!provider || !rawId) return undefined;
	const prefix = `${provider}/`;
	const cleanModelId = rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId;
	return { provider, modelId: cleanModelId };
}

export function formatModelCliArg(ref: { provider: string; modelId: string }): string {
	const normalized = normalizeModelReference(ref);
	if (!normalized) return `${ref.provider}/${ref.modelId}`;
	return `${normalized.provider}/${normalized.modelId}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/model-ref-normalization.test.ts`
Expected: PASS

- [ ] **Step 5: Verify layer boundary firewall**

Run: `node scripts/verify-layer-boundaries.mjs`
Expected: 0 boundary violations

- [ ] **Step 6: Commit**

```bash
git add src/shared/model-ref.ts tests/model-ref-normalization.test.ts
git commit -m "feat(shared): add canonical model reference normalizer"
```

---

### Task 2: Subagent Model Resolution & Prefix Immunity (BL-01, BL-05)

**Files:**
- Modify: `src/policy/resolver.ts`
- Modify: `src/runner/subagent.ts`
- Test: `tests/subagent-policy-error-handling.test.ts`
- Test: `tests/red-subagent-model-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/red-subagent-model-resolution.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSubagentModelConfiguration } from "../src/policy/resolver.ts";

test("resolveSubagentModelConfiguration resolves inherit mode when parent has .id instead of .modelId", () => {
	const policy = { version: 1 as const, revision: 0, policy: { mode: "inherit" as const } };
	const parentContext = {
		model: { provider: "antigravity", id: "gemini-3.8-flash" } as any,
		thinkingLevel: "high" as const,
	};
	const resolved = resolveSubagentModelConfiguration(policy, parentContext, []);
	assert.equal(resolved.model.provider, "antigravity");
	assert.equal(resolved.model.modelId, "gemini-3.8-flash");
});

test("resolveSubagentModelConfiguration normalizes provider prefix in configured mode", () => {
	const availableModels = [
		{ provider: "antigravity", id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", reasoning: true },
	] as any[];
	const policy = {
		version: 1 as const,
		revision: 1,
		policy: {
			mode: "configured" as const,
			configuredProfile: {
				model: { provider: "antigravity", modelId: "antigravity/gemini-3.8-flash" },
				thinkingLevel: "high" as const,
			},
		},
	};
	const resolved = resolveSubagentModelConfiguration(policy, {}, availableModels);
	assert.equal(resolved.model.provider, "antigravity");
	assert.equal(resolved.model.modelId, "gemini-3.8-flash");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/red-subagent-model-resolution.test.ts`
Expected: FAIL (Throws `SubagentPolicyInvalidError` and `SubagentModelUnavailableError`)

- [ ] **Step 3: Implement minimal code**

In `src/policy/resolver.ts`:
- Import `normalizeModelReference` from `../shared/model-ref.ts`.
- In `inherit` branch:
  ```ts
  const parentModel = normalizeModelReference(parentContext.model);
  if (!parentModel) {
      throw new SubagentPolicyInvalidError("Parent model is required for inherit mode");
  }
  ```
- In `configured` branch:
  ```ts
  const targetModel = normalizeModelReference(targetProfile.model);
  const matched = availableModels.find((m) => {
      const availableNorm = normalizeModelReference(m, m.provider);
      return (
          availableNorm &&
          availableNorm.provider === targetModel.provider &&
          availableNorm.modelId === targetModel.modelId
      );
  });
  ```

In `src/runner/subagent.ts`:
- Use `normalizeModelReference(parentAgent?.model)` to supply parent model context.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/red-subagent-model-resolution.test.ts tests/subagent-policy-error-handling.test.ts`
Expected: PASS

- [ ] **Step 5: Verify layer boundary firewall & line budgets**

Run: `node scripts/verify-layer-boundaries.mjs && wc -l src/policy/resolver.ts src/runner/subagent.ts`
Expected: 0 boundary violations, both files < 200 lines.

- [ ] **Step 6: Commit**

```bash
git add src/policy/resolver.ts src/runner/subagent.ts tests/red-subagent-model-resolution.test.ts
git commit -m "fix(policy): normalize model references in inherit and configured modes"
```

---

### Task 3: Subthread Spawner Model CLI Cleanliness & Turn Guard (BL-02, BL-07)

**Files:**
- Modify: `src/host/subthread-spawner.ts`
- Modify: `src/host/child-turn-guard.ts`
- Test: `tests/subthread-spawner-model-args.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/subthread-spawner-model-args.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildSpawnArgs } from "../src/host/subthread-spawner.ts";

test("buildSpawnArgs formats clean --model argument without double provider prefix", () => {
	const args = {
		parentThreadId: "thr_parent_123",
		title: "Subagent Task",
		task: "Verify security",
		actualModel: { provider: "antigravity", modelId: "antigravity/gemini-3.8-flash" },
		thinkingLevel: "high",
	};
	const cliArgs = buildSpawnArgs(args);
	const modelIndex = cliArgs.indexOf("--model");
	assert.ok(modelIndex !== -1);
	assert.equal(cliArgs[modelIndex + 1], "antigravity/gemini-3.8-flash");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/subthread-spawner-model-args.test.ts`
Expected: FAIL (outputs `"antigravity/antigravity/gemini-3.8-flash"`)

- [ ] **Step 3: Implement minimal code**

In `src/host/subthread-spawner.ts`:
- Import `formatModelCliArg` from `../shared/model-ref.ts`.
- Format `--model`:
  ```ts
  if (args.actualModel?.provider && args.actualModel?.modelId) {
      cliArgs.push("--model", formatModelCliArg(args.actualModel));
  }
  ```

In `src/host/child-turn-guard.ts`:
- Import `normalizeModelReference` from `../shared/model-ref.ts`.
- Normalize both `reqModel` and `actualModel` before comparison in `validateChildTurn`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/subthread-spawner-model-args.test.ts`
Expected: PASS

- [ ] **Step 5: Verify layer boundary firewall & line budgets**

Run: `node scripts/verify-layer-boundaries.mjs && wc -l src/host/subthread-spawner.ts src/host/child-turn-guard.ts`
Expected: 0 boundary violations, both files < 200 lines.

- [ ] **Step 6: Commit**

```bash
git add src/host/subthread-spawner.ts src/host/child-turn-guard.ts tests/subthread-spawner-model-args.test.ts
git commit -m "fix(host): clean CLI model flags and child turn model comparison"
```

---

### Task 4: Elimination of Destructive SIGTERM in Session Lock (BL-03)

**Files:**
- Modify: `src/runner/session-storage.ts`
- Test: `tests/session-storage-pid-safety.test.ts`

- [ ] **Step 1: Write the failing test**

Add test to `tests/session-storage-pid-safety.test.ts`:
```ts
test("acquireSessionLock fails closed with SessionAlreadyLockedError and NEVER sends SIGTERM to live process", () => {
    // When owner is alive and verified, acquireSessionLock must throw without calling kill
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/session-storage-pid-safety.test.ts`
Expected: Test fails or existing takeover tests confirm SIGTERM behavior.

- [ ] **Step 3: Implement minimal code**

In `src/runner/session-storage.ts`:
- Remove `process.kill(owner.pid, "SIGTERM")`.
- When `owner` is alive and verified:
  ```ts
  throw new DurableStorageError(
      `Session is already open in another live process (pid ${owner.pid}): ${directory}`,
      "SESSION_ALREADY_OPEN",
  );
  ```
- Stale lockfiles from DEAD processes (`!isProcessAlive(owner.pid)`) are safely cleaned up.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/session-storage-pid-safety.test.ts`
Expected: PASS

- [ ] **Step 5: Verify layer boundary firewall & line budgets**

Run: `node scripts/verify-layer-boundaries.mjs && wc -l src/runner/session-storage.ts`
Expected: 0 boundary violations, `session-storage.ts` < 200 lines.

- [ ] **Step 6: Commit**

```bash
git add src/runner/session-storage.ts tests/session-storage-pid-safety.test.ts
git commit -m "fix(runner): remove destructive SIGTERM in session lock acquisition"
```

---

### Task 5: Courier Request ID Rotation on Unanswered Retries (BL-04)

**Files:**
- Modify: `src/runner/subagent-courier.ts`
- Test: `tests/subagent-courier-lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/subagent-courier-lifecycle.test.ts`, add test verifying that when a submission is retried after hold/unanswered, `requestId` rotates.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/subagent-courier-lifecycle.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement minimal code**

In `src/runner/subagent-courier.ts`:
- When transitioning from `hold` or preparing a retry in `next`:
  Increment retry counter:
  ```ts
  const retryCount = (doc.sending.retries ?? 0) + 1;
  const freshRequestId = `subagent-batch:${task.id}:${doc.sending.batchNumber}:r${retryCount}`;
  ```
- If retries exceed 3, log diagnostic and clear batch.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/subagent-courier-lifecycle.test.ts`
Expected: PASS

- [ ] **Step 5: Verify layer boundary firewall & line budgets**

Run: `node scripts/verify-layer-boundaries.mjs && wc -l src/runner/subagent-courier.ts`
Expected: 0 boundary violations, file < 200 lines.

- [ ] **Step 6: Commit**

```bash
git add src/runner/subagent-courier.ts tests/subagent-courier-lifecycle.test.ts
git commit -m "fix(runner): rotate requestId on courier retry to prevent unanswered deadlock"
```

---

### Task 6: Cascading Abort on Parent Thread Stop & Spawn Failure Notification (BL-06, BL-08)

**Files:**
- Modify: `src/host/session-registry.ts`
- Modify: `src/host/session-subagent-handler.ts`
- Test: `tests/session-stop-cascading-abort.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/session-stop-cascading-abort.test.ts` testing that `SessionRegistry.stop()` calls `session.abort()` when the stopped thread is the parent, and that child spawn failure emits a warning.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/session-stop-cascading-abort.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement minimal code**

In `src/host/session-registry.ts`:
- In `stop(threadId)`: when stopping a parent session, call `await session.abort()` to terminate all background subagents cleanly.

In `src/host/session-subagent-handler.ts`:
- If `spawnSubthreadInBb` returns `undefined`, emit an explicit warning item or error delta into the parent thread stream.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/session-stop-cascading-abort.test.ts`
Expected: PASS

- [ ] **Step 5: Verify layer boundary firewall & line budgets**

Run: `node scripts/verify-layer-boundaries.mjs && wc -l src/host/session-registry.ts src/host/session-subagent-handler.ts`
Expected: 0 boundary violations, all files < 250 lines.

- [ ] **Step 6: Commit**

```bash
git add src/host/session-registry.ts src/host/session-subagent-handler.ts tests/session-stop-cascading-abort.test.ts
git commit -m "fix(host): cascading abort on thread stop and visible spawn error notification"
```

---

### Task 7: Doctor Diagnostics Order & Bounded Task Graph Memory (BL-09, BL-10)

**Files:**
- Modify: `src/host/diagnostics.ts`
- Modify: `src/runner/runtime-graph-source.ts`
- Modify: `src/runner/task-labels.ts`
- Test: `tests/diagnostics-init-order.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/diagnostics-init-order.test.ts`:
- Test that `RuntimeGraphSource` bounds `nativeStartedAt` map to <= 256 entries.
- Test that `TaskNames` bounds registry entries to <= 512.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/diagnostics-init-order.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement minimal code**

In `src/runner/runtime-graph-source.ts`:
- Implement LRU eviction when `nativeStartedAt.size > 256`.

In `src/runner/task-labels.ts`:
- Implement bounded capacity on `names` and `details`.

In `src/host/diagnostics.ts`:
- Check model availability after extensions have registered providers.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/diagnostics-init-order.test.ts`
Expected: PASS

- [ ] **Step 5: Verify layer boundary firewall & line budgets**

Run: `node scripts/verify-layer-boundaries.mjs && wc -l src/host/diagnostics.ts src/runner/runtime-graph-source.ts src/runner/task-labels.ts`
Expected: 0 boundary violations, all files < 200 lines.

- [ ] **Step 6: Commit**

```bash
git add src/host/diagnostics.ts src/runner/runtime-graph-source.ts src/runner/task-labels.ts tests/diagnostics-init-order.test.ts
git commit -m "fix(runner,host): bound task graph memory and fix doctor model diagnostic order"
```

---

### Task 8: Full Dual-Circuit Verification, Ledger & Release v0.4.2

**Files:**
- Modify: `package.json` (bump to 0.4.2)
- Modify: `docs/arch-improvement/ledger.md`
- Modify: `docs/arch-improvement/memory.md`

- [ ] **Step 1: Run full automated verification suite**

Run:
```bash
npm run test:contracts
node scripts/verify-layer-boundaries.mjs
node scripts/verify-import-graph.mjs
npm test
npm run doctor
```
Expected: All tests pass (>= 735 tests), 0 boundary violations, 0 cycles, Doctor clean.

- [ ] **Step 2: Check AP-019 line budgets**

Run: `find src -name "*.ts" -o -name "*.tsx" | xargs wc -l | sort -n | tail -n 15`
Expected: 100% of files < 250 LOC.

- [ ] **Step 3: Build distribution artifacts**

Run: `npm run build`
Expected: `dist/runner/index.js`, `dist/server.js`, `dist/app.js`, `dist/host.js` successfully compiled.

- [ ] **Step 4: Update ledger and memory**

Record Cycle 101 entry in `docs/arch-improvement/ledger.md` and lessons learned in `docs/arch-improvement/memory.md`.

- [ ] **Step 5: Commit release v0.4.2**

```bash
git add -A
git commit -m "release(v0.4.2): complete Cycle 101 Sovereign Subagents and Anti-Fragile Lifecycle"
git tag -a v0.4.2 -m "Release v0.4.2: Sovereign Subagents & Anti-Fragile Lifecycle"
```
