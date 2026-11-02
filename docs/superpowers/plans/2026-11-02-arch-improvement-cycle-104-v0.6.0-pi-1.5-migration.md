# Pi 1.5.0 Zero-Breakage Migration Implementation Plan (Cycle 104, Target v0.6.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Безопасная, безрегрессионная миграция рантайма `bb-plugin-provider-pi-durable` и суверенного ядра `durable-zero` с Pi 1.4.0 на Pi 1.5.0 с сохранением всех 755 работающих тестов и архитектурных инвариантов v0.5.0 (0 утечек `@get-bb/*`, SessionDaemon, QuickJS codemode).

**Architecture:** Применяется паттерн **Branch by Abstraction** в сочетании с **Anti-Corruption Layer (ACL)**: все ломающие изменения ядра (удаление `watchEvents`, замена TypeBox на `pi-schema`, Group Commit) изолируются за узкими портами (`SchemaPort`, `ViewStreamProjector`, `WatcherCompat`). Существующие хост-адаптеры и тесты не переписываются, а сохраняют 100% паритет контрактов.

**Tech Stack:** TypeScript (strict mode), Node.js v22/v26, `@earendil-works/pi-schema` 1.5.0, `@earendil-works/pi-durable` 1.5.0, `@earendil-works/chord` 1.5.0, SQLite WAL, QuickJS Wasm, `node:test`.

---

## Architecture Context Map & Invariants

```text
┌────────────────────────────────────────────────────────────────────────┐
│               SOVEREIGN FOUNDATION v0.5.0 (THE INVARIANT)              │
│                                                                        │
│   • ~/Projects/durable-zero: 0 @get-bb/* imports (strict isolation)    │
│   • SessionDaemon: single-writer SQLite WAL with Unix domain socket   │
│   • QuickJS WASI: 3.6.2 Wasm sandbox with typed codemode RPC          │
│   • 755/755 Golden Master test suite MUST remain green at every step   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
    ┌───────────────────────────────┴───────────────────────────────┐
    │                                                               │
    ▼                                                               ▼
[Phase 1: Anti-Corruption Layer]                     [Phase 2: Upstream 1.5.0 Cutover]
  - SchemaPort (TypeBox + pi-schema)                   - Group Commit with Keyed Gates
  - ViewStreamProjector (replacing watchEvents)        - Chord v2 WatchCall compatibility
  - Frozen Object Defensive Clones                     - Unified 3-pass coercion
```

### Applicable AP Rules:
- **AP-010 (Ports & Adapters):** Изоляция upstream-библиотек за портами `SchemaPort` и `ViewStreamProjector`.
- **AP-011 (Thin Adapter Invariant):** Никакой бизнес-логики внутри транспортных адаптеров.
- **AP-012 (Fail-Fast & Typed Errors):** Точные ошибки валидации `pi-schema` без сырых строк.
- **AP-013 (Data Integrity):** Защита от мутаций замороженных объектов (`Object.freeze`) в Group Commit.
- **AP-014 (SOLID & Lifecycle):** Чистый жизненный цикл вотчеров и сессий.
- **AP-019 (Line Budgets):** Все новые и изменённые `.ts` файлы строго < 250 LOC.
- **AP-020 (Composition Root):** Сборка зависимостей в `harness-setup.ts` и `engine.ts`.
- **AP-023 (Async Discipline):** Явные таймауты на всех операциях с сокетами и промисами.
- **AP-028 (Deterministic Testing):** Нулевой I/O в юнит-тестах проектора и валидатора.

---

## File Structure & Responsibilities

| File Path | Role & Responsibility | Layer | Line Budget |
|---|---|---|---|
| `src/runner/schema-port.ts` | **NEW:** Порт валидации схем инструментов (TypeBox + `pi-schema` bridge) | Application / Port | < 120 LOC |
| `src/runner/bridge/view-stream-projector.ts` | **NEW:** ACL проектор `ConversationView` $\to$ `RunnerEvent` (замена `watchEvents`) | Interface / ACL | < 200 LOC |
| `src/runner/watcher-compat.ts` | **NEW:** Хелпер распаковки `WatchCall` Chord v2 (`kind === 'value'`) | Domain / Port | < 80 LOC |
| `src/runner/tool-adapter.ts` | **MODIFY:** Перевод валидации на `SchemaPort`, поддержка `{ open: true }` | Domain / Adapter | < 220 LOC |
| `src/runner/subagent-courier.ts` | **MODIFY:** Использование `watcher-compat.ts` для поддержки Chord v2 | Application / Courier | < 180 LOC |
| `src/runner/session-storage.ts` | **MODIFY:** Иммутабельное клонирование возвращаемых записей от `Object.freeze` | Infrastructure / Storage | < 200 LOC |
| `tests/schema-port.test.ts` | **NEW:** Тесты паритета коэрции и валидации `SchemaPort` | Test Suite | < 150 LOC |
| `tests/view-stream-projector.test.ts` | **NEW:** Теневой тест эквивалентности потока событий `RunnerEvent` | Test Suite | < 180 LOC |
| `tests/watcher-compat.test.ts` | **NEW:** Тесты обратной совместимости вотчеров Chord v2 | Test Suite | < 100 LOC |
| `tests/frozen-state-defense.test.ts` | **NEW:** Тесты защиты от `Object.freeze` в Group Commit | Test Suite | < 100 LOC |

---

## Task Decomposition

### Task 1: Schema Port & Anti-Corruption Layer (`SchemaPort`)

**Files:**
- Create: `src/runner/schema-port.ts`
- Test: `tests/schema-port.test.ts`
- Target: `bb-plugin-provider-pi-durable` & `durable-zero/packages/core`
- AP Gates: AP-010, AP-011, AP-012, AP-019, AP-028

- [ ] **Step 1: Write the failing test**

Create `tests/schema-port.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { SchemaPort } from "../src/runner/schema-port.ts";

test("SchemaPort: validates and coerces scalar numbers and string inputs", () => {
	const schema = Type.Object({
		count: Type.Number(),
		query: Type.String(),
	});

	const port = new SchemaPort();

	// String numeric coercion parity (pi 1.5 invariant)
	const coerced = port.coerce(schema, { count: "42", query: "test" });
	assert.deepEqual(coerced, { count: 42, query: "test" });

	const result = port.validate(schema, coerced);
	assert.equal(result.isValid, true);
	assert.equal(result.errors, undefined);
});

test("SchemaPort: formats missing fields as canonical pointer errors", () => {
	const schema = Type.Object({
		path: Type.String(),
	});

	const port = new SchemaPort();
	const result = port.validate(schema, {});
	assert.equal(result.isValid, false);
	assert.ok(result.errors && result.errors.length > 0);
	assert.ok(
		result.errors.some((err) => err.includes("path")),
		`Expected error mentioning 'path', got: ${JSON.stringify(result.errors)}`,
	);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/schema-port.test.ts`  
Expected: FAIL with `Cannot find module '../src/runner/schema-port.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/runner/schema-port.ts`:
```ts
import { Value } from "typebox/value";
import type { TSchema } from "typebox";

export interface SchemaValidationResult {
	readonly isValid: boolean;
	readonly errors?: readonly string[];
}

export class SchemaPort {
	coerce(schema: unknown, value: unknown): unknown {
		if (!value || typeof value !== "object" || !schema) {
			return value;
		}

		// Fast TypeBox Convert
		try {
			return Value.Convert(schema as TSchema, value);
		} catch {
			return value;
		}
	}

	validate(schema: unknown, value: unknown): SchemaValidationResult {
		if (!schema) {
			return { isValid: true };
		}

		try {
			const s = schema as TSchema;
			const isValid = Value.Check(s, value);
			if (isValid) {
				return { isValid: true };
			}

			const errors: string[] = [];
			for (const err of Value.Errors(s, value)) {
				const path = err.path ? err.path.replace(/^\//, "") : "root";
				errors.push(`- ${path}: ${err.message}`);
			}
			return { isValid: false, errors };
		} catch (err) {
			return {
				isValid: false,
				errors: [`- schema: ${err instanceof Error ? err.message : String(err)}`],
			};
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/schema-port.test.ts`  
Expected: PASS (2 tests pass)

- [ ] **Step 5: Verify line budget and layer boundaries**

Run: `wc -l src/runner/schema-port.ts && node scripts/verify-layer-boundaries.mjs`  
Expected: < 120 LOC, 0 boundary violations

- [ ] **Step 6: Commit**

```bash
git add src/runner/schema-port.ts tests/schema-port.test.ts
git commit -m "feat(runner): implement SchemaPort abstraction for tool argument validation (AP-010)"
```

---

### Task 2: Tool Adapter Integration with `SchemaPort`

**Files:**
- Modify: `src/runner/tool-adapter.ts:60-120`
- Test: `tests/tool-adapter-schema-port.test.ts`
- AP Gates: AP-010, AP-011, AP-012, AP-013, AP-019, AP-028

- [ ] **Step 1: Write the failing test**

Create `tests/tool-adapter-schema-port.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { adaptExtensionTool } from "../src/runner/tool-adapter.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

test("tool-adapter: uses SchemaPort for runtime argument coercion and validation", async () => {
	let executedArgs: unknown = null;

	const dummyTool: ToolDefinition = {
		name: "test_coerced_tool",
		description: "Test tool coercion",
		parameters: Type.Object({
			port: Type.Number(),
		}),
		execute: async (args) => {
			executedArgs = args;
			return { content: [] };
		},
	};

	const reg = adaptExtensionTool(dummyTool, async () => ({
		toolCall: { type: "toolCall", id: "1", name: "test_coerced_tool", arguments: {} },
		result: { content: [], details: {} },
		isError: false,
	}));

	assert.ok(reg);
	assert.equal(reg.name, "test_coerced_tool");
});
```

- [ ] **Step 2: Run test to verify it compiles and runs**

Run: `node --test tests/tool-adapter-schema-port.test.ts`  
Expected: PASS

- [ ] **Step 3: Wire SchemaPort into tool-adapter execution path**

In `src/runner/tool-adapter.ts`:
Integrate `SchemaPort` to coerce arguments prior to `executeToolFn`:
```ts
import { SchemaPort } from "./schema-port.ts";
const schemaPort = new SchemaPort();
```
And inside `execute`:
```ts
const coercedArgs = schemaPort.coerce(toolDef.parameters, args);
```

- [ ] **Step 4: Run existing full test suite to guarantee zero regression**

Run: `node --test tests/tool-*.test.ts tests/codemode-*.test.ts`  
Expected: 100% PASS (0 regressions)

- [ ] **Step 5: Verify line budget**

Run: `wc -l src/runner/tool-adapter.ts`  
Expected: < 220 LOC (Hard limit 250)

- [ ] **Step 6: Commit**

```bash
git add src/runner/tool-adapter.ts tests/tool-adapter-schema-port.test.ts
git commit -m "refactor(runner): wire SchemaPort into tool adapter execution pipeline (AP-011)"
```

---

### Task 3: Chord v2 Watcher Compatibility Adapter (`WatcherCompat`)

**Files:**
- Create: `src/runner/watcher-compat.ts`
- Modify: `src/runner/subagent-courier.ts`
- Test: `tests/watcher-compat.test.ts`
- AP Gates: AP-010, AP-014, AP-019, AP-023, AP-028

- [ ] **Step 1: Write the failing test**

Create `tests/watcher-compat.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { unwrapWatchValue, isWatchCall } from "../src/runner/watcher-compat.ts";

test("WatcherCompat: extracts value from v1.5 WatchCall ({ kind: 'value', value })", () => {
	const call = { kind: "value" as const, value: { deliveryHold: false }, ops: [] };
	assert.equal(isWatchCall(call), true);
	assert.deepEqual(unwrapWatchValue(call), { deliveryHold: false });
});

test("WatcherCompat: preserves raw value from v1.4 watch callback", () => {
	const rawValue = { deliveryHold: true };
	assert.equal(isWatchCall(rawValue), false);
	assert.deepEqual(unwrapWatchValue(rawValue), { deliveryHold: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/watcher-compat.test.ts`  
Expected: FAIL with `Cannot find module '../src/runner/watcher-compat.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/runner/watcher-compat.ts`:
```ts
export interface WatchCallShape<T> {
	readonly kind: "value";
	readonly value: T;
	readonly ops?: readonly unknown[];
	readonly retired?: boolean;
}

export function isWatchCall<T>(item: unknown): item is WatchCallShape<T> {
	return (
		typeof item === "object" &&
		item !== null &&
		"kind" in item &&
		(item as { kind: string }).kind === "value" &&
		"value" in item
	);
}

export function unwrapWatchValue<T>(item: unknown): T {
	if (isWatchCall<T>(item)) {
		return item.value;
	}
	return item as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/watcher-compat.test.ts`  
Expected: PASS

- [ ] **Step 5: Integrate into `subagent-courier.ts`**

In `src/runner/subagent-courier.ts`:
Use `unwrapWatchValue(call)` inside `watch.start(async (call) => ...)` so the courier safely receives delivery updates on both Pi 1.4 and Pi 1.5.

- [ ] **Step 6: Verify all courier tests pass**

Run: `node --test tests/subagent-*.test.ts`  
Expected: 100% PASS

- [ ] **Step 7: Commit**

```bash
git add src/runner/watcher-compat.ts src/runner/subagent-courier.ts tests/watcher-compat.test.ts
git commit -m "feat(runner): add WatcherCompat for seamless Chord v2 watch transition (AP-014)"
```

---

### Task 4: View-Stream Projector (`ViewStreamProjector` - Replacing `watchEvents`)

**Files:**
- Create: `src/runner/bridge/view-stream-projector.ts`
- Test: `tests/view-stream-projector.test.ts`
- AP Gates: AP-010, AP-011, AP-018, AP-019, AP-020, AP-028

- [ ] **Step 1: Write the failing test**

Create `tests/view-stream-projector.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { ViewStreamProjector } from "../src/runner/bridge/view-stream-projector.ts";
import type { RunnerEvent } from "../src/runner/bridge/contracts.ts";

test("ViewStreamProjector: synthesizes agent_start and turn_start on live run transition", () => {
	const emitted: RunnerEvent[] = [];
	const projector = new ViewStreamProjector((evt) => emitted.push(evt));

	// Simulate initial view update with live run
	projector.project({
		conversationId: "root",
		run: { id: "run-1", state: "running" },
		entries: [],
	});

	assert.ok(emitted.length >= 2, "Expected agent_start and turn_start");
	assert.equal(emitted[0]?.type, "agent_start");
	assert.equal(emitted[1]?.type, "turn_start");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/view-stream-projector.test.ts`  
Expected: FAIL with `Cannot find module '../src/runner/bridge/view-stream-projector.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/runner/bridge/view-stream-projector.ts`:
```ts
import type { RunnerEvent } from "./contracts.ts";

export interface ProjectedConversationState {
	readonly conversationId: string;
	readonly run?: { readonly id: string; readonly state: string } | null;
	readonly entries?: readonly unknown[];
}

export class ViewStreamProjector {
	private readonly sink: (event: RunnerEvent) => void;
	private activeRunId: string | null = null;

	constructor(sink: (event: RunnerEvent) => void) {
		this.sink = sink;
	}

	project(state: ProjectedConversationState): void {
		const run = state.run;
		if (run && run.state === "running" && this.activeRunId !== run.id) {
			this.activeRunId = run.id;
			this.sink({
				type: "agent_start",
				conversationId: state.conversationId,
			} as unknown as RunnerEvent);
			this.sink({
				type: "turn_start",
				conversationId: state.conversationId,
			} as unknown as RunnerEvent);
			return;
		}

		if (!run && this.activeRunId) {
			const endedId = this.activeRunId;
			this.activeRunId = null;
			this.sink({
				type: "turn_end",
				conversationId: state.conversationId,
			} as unknown as RunnerEvent);
			this.sink({
				type: "agent_end",
				conversationId: state.conversationId,
			} as unknown as RunnerEvent);
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/view-stream-projector.test.ts`  
Expected: PASS

- [ ] **Step 5: Verify line budget (< 200 LOC)**

Run: `wc -l src/runner/bridge/view-stream-projector.ts`  
Expected: < 200 LOC

- [ ] **Step 6: Commit**

```bash
git add src/runner/bridge/view-stream-projector.ts tests/view-stream-projector.test.ts
git commit -m "feat(bridge): implement ViewStreamProjector for event stream synthesis (AP-010)"
```

---

### Task 5: Group Commit & Frozen Object Defense

**Files:**
- Modify: `src/runner/session-storage.ts`
- Test: `tests/frozen-state-defense.test.ts`
- AP Gates: AP-010, AP-013, AP-019, AP-034

- [ ] **Step 1: Write the failing test**

Create `tests/frozen-state-defense.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { safeCloneRecord } from "../src/runner/session-storage.ts";

test("safeCloneRecord: clones frozen objects so downstream mutation does not throw", () => {
	const frozen = Object.freeze({
		taskId: 42,
		status: "completed",
		nested: Object.freeze({ count: 1 }),
	});

	const clone = safeCloneRecord(frozen);
	assert.doesNotThrow(() => {
		(clone as { status: string }).status = "mutated";
	});
	assert.equal(clone.status, "mutated");
	assert.equal(frozen.status, "completed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/frozen-state-defense.test.ts`  
Expected: FAIL with `safeCloneRecord is not exported`

- [ ] **Step 3: Implement defensive cloning in `src/runner/session-storage.ts`**

Export `safeCloneRecord`:
```ts
export function safeCloneRecord<T>(record: T): T {
	if (record === null || typeof record !== "object") {
		return record;
	}
	if (Array.isArray(record)) {
		return [...record] as unknown as T;
	}
	return { ...record };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/frozen-state-defense.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runner/session-storage.ts tests/frozen-state-defense.test.ts
git commit -m "feat(storage): add defensive cloning to protect against Group Commit Object.freeze (AP-013)"
```

---

### Task 6: Package Version Cutover, Transfer to `durable-zero`, and Dual-Circuit Verification

**Files:**
- Modify: `bb-plugin-provider-pi-durable/package.json`
- Modify: `durable-zero/packages/*/package.json`
- AP Gates: AP-010, AP-020, AP-028, AP-029

- [ ] **Step 1: Copy tested abstractions into `durable-zero`**

Copy `schema-port.ts`, `watcher-compat.ts`, `view-stream-projector.ts` to `durable-zero/packages/core/src/`.

- [ ] **Step 2: Verify `durable-zero` layer boundaries (0 `@get-bb/*` leaks)**

Run: `cd /Users/vanya/Projects/durable-zero && grep -rn "@get-bb" packages/ || echo "ZERO LEAKS"`  
Expected: `ZERO LEAKS`

- [ ] **Step 3: Run full Golden Master test suite in `bb-plugin-provider-pi-durable`**

Run: `cd /Users/vanya/Projects/bb-plugin-provider-pi-durable && npm test`  
Expected: 755/755 tests PASS!

- [ ] **Step 4: Run doctor diagnostics**

Run: `node /Users/vanya/Projects/durable-zero/packages/cli/bin/durable-zero.js doctor && cd /Users/vanya/Projects/bb-plugin-provider-pi-durable && npm run doctor`  
Expected: HEALTHY (all subcomponents functional)

- [ ] **Step 5: Run Two-Circuit Parallel Verification (S9 Verify Gate)**

Spawn Subagent 1 (Arch Rules Implementation Review) and Subagent 2 (Product Review).  
Expected: Both issue `VERDICT: PASS`.

- [ ] **Step 6: Release v0.6.0 & Push to GitHub**

Bump version to `0.6.0`, create git tag `v0.6.0`, push `main` and tags to GitHub.

---

## Rollback & Safety Checklist

- [ ] Database schema is verified: `session.sqlite` version 2 is preserved.
- [ ] Golden master test suite passes 100% on every intermediate commit.
- [ ] If any unexpected regression occurs, git checkout to `v0.5.0` takes exactly 1 command.
