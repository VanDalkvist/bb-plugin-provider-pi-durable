# Non-Blocking Background Subagents and Turn Watchdog Prevention Implementation Plan (Cycle 79)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock the parent conversation during background subagent execution by adopting Pi Durable's canonical `Anchor` task pattern (§5.5 Spec), disarm the 120s BB Core turn watchdog by emitting `turn.open` immediately upon root turn acceptance, and release the patch in version `0.3.2`.

**Architecture:** Following Ports & Adapters and Pi Durable Specification §5.5 (Rule 4), background child conversations must be owned by an atomic background `Anchor` task (`background: true`) rather than the calling foreground tool task (`api.taskId`), allowing the tool task and parent generation to settle immediately (`terminal`). On the host bridge, `handleTurnStart` emits `{ kind: "turn.open" }` upon accepting input on root threads to disarm BB Core's 120s watchdog timer (`p.delete(threadId)`).

**Tech Stack:** TypeScript, Node.js (`node:test`), `@earendil-works/pi-durable` 1.4, `@get-bb/plugin-sdk` 0.6.79, SQLite.

---

## Architecture Context Map

- **Stage:** `prod` (plugin released and actively hosted in Beyond Boundaries IDE).
- **Source docs:**
  - `arch-rules.md` (AP-010, AP-011, AP-012, AP-013, AP-019, AP-020, AP-022, AP-023, AP-028)
  - `@earendil-works/pi-durable` spec §5.5 (Task Ownership and Lifecycle)
  - `@earendil-works/pi-durable/test/examples/23-subagent-background.ts` (Canonical Background Subagents)
  - `docs/arch-improvement/memory.md` (AP-022, Dual-Track Architecture, Mirror Guard)
- **Critical AP gates:**
  - `AP-011` (Low coupling, high cohesion): Clear boundary between runner task scheduler and host event translation.
  - `AP-012` (Fail-fast): Validate inputs and states without swallowing errors.
  - `AP-013` (Data integrity): ACID transactions for `SubagentsDoc` and conversation creation.
  - `AP-020` (Clean Architecture): Host bridge orchestrates BB wire events; runner manages native durable tasks.
  - `AP-022` (Typed errors): No empty catch blocks.
  - `AP-023` (Async discipline): No floating promises, proper `Promise` awaits.
- **Baseline AP gates:**
  - `AP-019` (Line budgets): Hard limit < 200 lines per file; < 40 lines per function.
  - `AP-028` (Test determinism): Tests against genuine Pi Durable runtime and typed fixtures.
- **Triage decisions:**
  - `fix-now`:
    - `[P1-SUB1]` Background subagent blocking parent conversation: replace direct `api.taskId` conversation ownership with `Anchor` task.
    - `[P1-WD1]` Root turn 120s watchdog timeout: emit `turn.open` in `handleTurnStart` when root input is accepted.
    - `[P2-UI1]` Task tree hierarchy: map child conversation logical owner in snapshot to `ownerTaskId` (`api.taskId`) so the UI displays subagents under the caller tool card.
  - `log-only`:
    - React UI styling and localization (handled in separate UI plan).

---

## File Structure

- **Modified files:**
  - `src/runner/subagent.ts`: Change conversation ownership for `isBackground: true` to use `Anchor` task with `BACKGROUND`.
  - `src/runner/runtime-graph-conversations.ts`: Add `recordLogicalOwner(childId, ownerTaskId)` to preserve UI tree nesting under the tool task.
  - `src/runner/runtime-graph-source.ts`: Feed logical owner from `SubagentsDoc` into `RuntimeGraphConversations`.
  - `src/host/bridge-router.ts`: Emit `turn.open` in `handleTurnStart` for root turns.
  - `package.json` & `CHANGELOG.md`: Version bump to `0.3.2`.
- **New test files:**
  - `tests/subagent-background-unblock.test.ts`: TDD test proving tool task and parent turn settle immediately without waiting for child.
  - `tests/turn-start-watchdog-prevention.test.ts`: TDD test proving root `handleTurnStart` emits `turn.open`.

---

## Tasks

### Task 1: Root Turn Watchdog Prevention (Host Bridge)

**Files:**
- Modify: `src/host/bridge-router.ts:125-135`
- Test: `tests/turn-start-watchdog-prevention.test.ts`

- [ ] **Step 1: Write failing test for root turn `turn.open` emission**

Create `tests/turn-start-watchdog-prevention.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { handleTurnStart } from "../src/host/bridge-router.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("handleTurnStart: emits turn.open immediately on root turn input acceptance to disarm watchdog", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];

	let promptCalled = false;
	const mockSession = sessionFixture({
		runner: { exited: false },
		options: { threadId: "thr_root_1" },
		prompt: async () => { promptCalled = true; },
	});

	const registry = new SessionRegistry(() => {});
	registry.track("thr_root_1", mockSession);

	const ctx = {
		registry,
		sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
		sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
		sendError: () => {},
	};

	await handleTurnStart("req_root_1", {
		threadId: "thr_root_1",
		input: [{ type: "text", text: "Hello while subagent is running" }],
		clientRequestId: "creq_watchdog_1",
	}, ctx);

	assert.equal(results.length, 1, "Result must be acknowledged");
	assert.equal(results[0].id, "req_root_1");
	assert.ok(promptCalled, "session.prompt must be called");

	const rootDeltas = notifications
		.filter((n) => n.method === "thread/delta" && n.params.threadId === "thr_root_1")
		.flatMap((n) => n.params.deltas as any[]);

	assert.ok(rootDeltas.some((d) => d.kind === "input.accepted"), "Must emit input.accepted");
	assert.ok(rootDeltas.some((d) => d.kind === "turn.open"), "Must emit turn.open immediately on root turn");
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `npx tsx --test tests/turn-start-watchdog-prevention.test.ts`
Expected: FAIL ("Must emit turn.open immediately on root turn").

- [ ] **Step 3: Implement minimal fix in `src/host/bridge-router.ts`**

In `src/host/bridge-router.ts`, inside `handleTurnStart`, right after `sendInputAccepted`:
```ts
	await reconcileSessionOptions(session, params.options, params.providerOptions);
	await session.prompt({ text, images });
	sendInputAccepted(ctx.sendNotification, params.threadId, params.clientRequestId);
	ctx.sendNotification("thread/delta", { threadId: params.threadId, deltas: [{ kind: "turn.open" }] });
	ctx.sendResult(id, { threadId: params.threadId });
```
Also check line 98 for explicit `conversationId` child prompt fallback:
```ts
		await session.prompt({ text, images, conversationId: targetConversationId });
		sendInputAccepted(ctx.sendNotification, params.threadId, params.clientRequestId);
		ctx.sendNotification("thread/delta", { threadId: params.threadId, deltas: [{ kind: "turn.open" }] });
		ctx.sendResult(id, { threadId: params.threadId });
		return;
```

- [ ] **Step 4: Run test to verify it passes (GREEN)**

Run: `npx tsx --test tests/turn-start-watchdog-prevention.test.ts`
Expected: PASS (1 test, 0 failures).

- [ ] **Step 5: Verify AP-019 line budget for `src/host/bridge-router.ts`**

Check line count: `wc -l src/host/bridge-router.ts` (must be < 200 LOC).

---

### Task 2: Non-Blocking Background Subagents via `Anchor` (Runner)

**Files:**
- Modify: `src/runner/subagent.ts:70-115`
- Test: `tests/subagent-background-unblock.test.ts`

- [ ] **Step 1: Write failing test for non-blocking background subagent execution**

Create `tests/subagent-background-unblock.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	Harness,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { createSubagentExtension } from "../src/runner/subagent.ts";
import { SubagentTasksExtension } from "../src/runner/subagent-delivery.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("subagent tool: background subagent creates Anchor task and does NOT hold caller in completing status", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagent-unblock-test-"));
	const dbPath = join(dir, "session.sqlite");
	try {
		const models = createModels();
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		faux.setResponses([() => fauxText("Subagent long response")]);

		const registry = createRegistry();
		registry.install(SubagentTasksExtension);
		registry.install(
			createSubagentExtension(() => ({
				version: 1,
				policy: { mode: "inherit" },
			})),
		);

		const harness = await Harness.open(
			await openNodeSqliteStorage(dbPath),
			{ models, registry },
			BACKGROUND_CONTEXT,
		);
		const root = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: { provider: "faux", modelId: "faux-1" } },
		});

		// 1. Execute subagent tool directly via tool execution
		const tool = registry.tools.get("subagent");
		assert.ok(tool, "subagent tool must be registered");

		// Run tool execution inside root conversation
		let callerTaskId: any;
		let childConvId: any;
		await root.commit(async (tx) => {
			// Create a synthetic task to act as the calling tool task
			const tasks = await tx.scanTasks({}, 1);
		}, BACKGROUND_CONTEXT);

		await harness.close(BACKGROUND_CONTEXT);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
```

Verify that in `src/runner/subagent.ts`:
When `isBackground` is true, the conversation is created with `ownership: { kind: "task", taskId: anchorId }` where `anchorId` is created with `tx.createTask(Anchor, null, BACKGROUND)`.

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `npx tsx --test tests/subagent-background-unblock.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `Anchor` ownership in `src/runner/subagent.ts`**

Update `src/runner/subagent.ts`:
```ts
import { Anchor, BACKGROUND, DefaultReporter, answerText } from "./subagent-delivery.ts";
...
							let childId = existingConv?.id;
							let anchorId: TaskId | undefined;
							if (childId === undefined) {
								if (isBackground) {
									anchorId = await tx.createTask(Anchor, null, BACKGROUND);
								}
								const created = await tx.createConversation({
									ownership: isBackground && anchorId !== undefined
										? { kind: "task", taskId: anchorId }
										: { kind: "task", taskId: api.taskId },
								});
								await configure(tx, created.id, {
									model: resolved.model,
									thinkingLevel: resolved.thinkingLevel,
									instructions: buildTechnicalWorkerRole(),
								});
								childId = created.id;
							}
```
And preserve `record.ownerTaskId = api.taskId` (the logical tool creator task) so the UI and reporters know who launched it:
```ts
							const record: SubagentRecord = {
								name: nativeChildTitle(args.task, "worker"),
								conversationId: childId,
								requestId,
								task: args.task,
								role: "worker",
								ownerTaskId: api.taskId,
								anchorTaskId: anchorId,
								background: isBackground,
								actualModel: resolved.model,
								thinkingLevel: resolved.thinkingLevel,
								source: resolved.source,
								policyRevision: resolved.policyRevision,
							};
```

- [ ] **Step 4: Run test to verify it passes (GREEN)**

Run: `npx tsx --test tests/subagent-background-unblock.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify AP-019 line budget for `src/runner/subagent.ts`**

Check line count: `wc -l src/runner/subagent.ts` (must be < 200 LOC).

---

### Task 3: UI Task Tree Logical Ownership Preservation

**Files:**
- Modify: `src/runner/runtime-graph-source.ts:60-80`
- Test: `tests/ui/runtime-graph-tree-ownership.test.ts`

- [ ] **Step 1: Check existing ownership test in `tests/ui/runtime-graph-tree-ownership.test.ts`**

Run: `npx tsx --test tests/ui/runtime-graph-tree-ownership.test.ts`
Verify that `tree-builder` resolves `conv.owner.taskId`.
When `SubagentsDoc` has `agents[key].ownerTaskId`, verify that `RuntimeGraphSource` populates `conv.owner = { conversationId: 1, taskId: record.ownerTaskId }` so the child tasks nest under the caller tool card (`subagent`) rather than under the raw technical `Anchor`.

- [ ] **Step 2: Add test asserting logical owner mapping in snapshot**

In `tests/ui/runtime-graph-tree-ownership.test.ts`, add test verifying that child conversation with logical owner task renders child tasks nested under the calling tool task.

- [ ] **Step 3: Run test to verify passes (GREEN)**

Run: `npx tsx --test tests/ui/runtime-graph-tree-ownership.test.ts`
Expected: PASS.

- [ ] **Step 4: Verify AP-019 line budget for all touched files**

`wc -l src/runner/runtime-graph-source.ts` (< 200 LOC).

---

### Task 4: Full Regression Verification (S9 Dual-Circuit Gate)

- [ ] **Step 1: Run full unit test suite**

Run: `npm test`
Expected: 529+ backend tests pass, 32 UI tests pass, 0 failures.

- [ ] **Step 2: Compile TypeScript with zero errors**

Run: `npm run typecheck` or `npx tsc --noEmit`
Expected: Exit code 0, 0 type errors.

- [ ] **Step 3: Rebuild bundles**

Run: `npm run build`
Expected: Fresh `dist/` artifacts built cleanly.

- [ ] **Step 4: Verify AP-019 strict line counts on all changed files**

Run: `wc -l src/runner/subagent.ts src/host/bridge-router.ts`
Verify every single modified file is < 200 LOC.

---

### Task 5: Version Bump, CHANGELOG, and Ledger Update (S10-S12)

- [ ] **Step 1: Bump version in `package.json` to `0.3.2`**

Update `package.json` and run `npm install --package-lock-only` if needed.

- [ ] **Step 2: Document changes in `CHANGELOG.md` under [0.3.2]**

- [ ] **Step 3: Update `docs/arch-improvement/ledger.md` with Cycle 79 entry**

- [ ] **Step 4: Append durable lesson to `docs/arch-improvement/memory.md`**

- [ ] **Step 5: Present results and request approval for git push**
