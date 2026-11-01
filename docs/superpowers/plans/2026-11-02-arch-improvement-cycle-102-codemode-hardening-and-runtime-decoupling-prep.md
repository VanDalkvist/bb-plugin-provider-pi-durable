# Arch Improvement Cycle 102: Codemode Hardening & Sovereign Runtime Decoupling Preparation

**Cycle:** 102  
**Date:** 2026-11-02  
**Status:** S7 (Plan Reviewed & Ready for Execution)  
**Goal:** Комплексная ликвидация дефектов подсистемы `codemode` и плагинов рантайма (BL-CM-01..BL-CM-04, BL-CM-08, BL-PI-05), устранение риска сдувания WASM-кэша (BL-CM-05), обобщение конверта субагентов (BL-CM-06) и подготовка 100% чистых архитектурных границ для физического выделения ядра `pi-durable-runtime` и `pi-durable-sdk` в отдельный репозиторий.  
**Orchestration Contract:** `~/Projects/AGENTS.md`  
**Required Skills:**
- `~/Projects/.agents/skills/arch/arch-improvement-loop/SKILL.md`
- `~/Projects/arch-improvement-skills/skills/arch-improvement-review/SKILL.md`
- `~/Projects/arch-rules-skills/skills/arch-rules-implementation-review/SKILL.md`
- `~/Projects/arch-rules/arch-rules.md` (AP-010, AP-011, AP-012, AP-013, AP-014, AP-019, AP-020, AP-023, AP-025, AP-026, AP-028, AP-029, AP-045, AP-047)
**PRD / Context Map:** `docs/superpowers/specs/2026-11-02-prd-pi-durable-sovereign-runtime-and-sdk-decoupling.md`  
**Audit Artifact:** `docs/arch-improvement/audits/2026-11-01-builtin-plugins-and-codemode-audit.md`  
**Diagnostic Reproducer:** `scripts/diagnose-codemode.ts`

---

## 1. S0 Bootstrap & S1 Memory Load

### S0 Bootstrap
- **Target Repo:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`
- **Branch:** `main` (commit `808fd69`)
- **Active Version:** `0.4.2`
- **Clean Worktree:** Документы спецификации и план зафиксированы в git.

### S1 Memory Load (Durable Lessons)
1. **From Cycle 100:** Фаервол слоев (`verify-layer-boundaries.mjs`) обязателен на каждом шаге. `src/runner/` не имеет права импортировать из `src/host/`.
2. **From Cycle 101:** Блокировка сессии SQLite в `session-storage.ts` никогда не должна слать `SIGTERM` по чужим процессам; конфликт должен разрешаться через `SESSION_ALREADY_OPEN` (fail-closed) или через сокет-демон.
3. **From Cycle 87:** Никаких пустых `catch {}` блоков (AP-022); все ошибки обязаны быть типизированы или проброшены.
4. **Current Incident:** QuickJS WASM модуль не должен зависеть от эфемерных путей кэша BB (`~/.bb/plugins/cache/git/...`). Зависимость `quickjs-wasi` обязана быть зафиксирована в прямых dependencies.

---

## 2. S2 Orientation: Architecture Context Map

```
┌────────────────────────────────────────────────────────────────────────┐
│  src/runner/ (Sovereign Core, 54 files)                                │
│  - Plugins: built-in/codemode.ts, built-in/coding-tools.ts, subagents. │
│  - Mount & Adapters: extension-mount.ts, tool-adapter.ts               │
│  - Namespaces: codemode-namespaces.ts                                  │
│  - Harness: harness-setup.ts, runtime-loader.ts, runtime.ts            │
│  - Rules: AP-010 (Hexagonal), AP-013 (Data Integrity), AP-019 (<250)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ stdio / JSON-RPC (0 leaks)
┌───────────────────────────────────▼────────────────────────────────────┐
│  src/contracts/ (Pure DTOs, 9 files)                                   │
│  - runner-command.ts, runner-event.ts, wire-tool.ts                    │
│  - Rules: AP-026 (Zero runtime dependencies, pure Zod)                 │
└───────────────────────────────────▲────────────────────────────────────┘
                                    │ consumes
┌───────────────────────────────────┴────────────────────────────────────┐
│  src/host/ (BB Adapter, 47 files)                                      │
│  - bridge.ts, bridge-router.ts, runner-process.ts, subthread-spawner.ts│
│  - Rules: AP-010 (Consumer only, no reverse imports from runner)       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. S4 Review: Severity-Ranked Findings (Arch Improvement Review)

- [P0] **BL-CM-01: Утеря `structuredOutput` в `createNestedToolExecutor` и `adaptExtensionTool`**
  - **Evidence:** `src/runner/extension-mount.ts:50–75`, `src/runner/tool-adapter.ts:18–26` и `128–132`. Метод `outcomeOf` в `@earendil-works/pi-durable` ожидает `result.structuredOutput`, а адаптер возвращает только `output: result.content`. При наличии `outputSchema` ядро выбрасывает `invalid_structured_output`, блокируя выполнение скрипта в QuickJS.
  - **Impact:** 100% отказ MCP-инструментов со структурированным ответом при вызове из `codemode`.
  - **Rule:** AP-012 (Fail-fast), AP-013 (Целостность данных), AP-026 (API-контракты).
  - **Fix decision:** `fix-now` (Slice 1).

- [P0] **BL-CM-02: Отсутствие `teardown()` в `codemodePlugin` и потеря `pluginRegistry` в `harness-setup.ts`**
  - **Evidence:** `src/runner/plugins/built-in/codemode.ts:5–18`, `src/runner/harness-setup.ts:87–105`. `CodemodeSandbox` создаётся анонимно без вызова `dispose()`/`close()`. `createCodingRegistry` локально инстанциирует `DurablePluginRegistry` и отбрасывает его, делая `teardownAll()` невозможным.
  - **Impact:** Утечка потоков `node:worker_threads` и памяти WebAssembly QuickJS на каждом цикле сессии.
  - **Rule:** AP-014 (Clean Lifecycle), AP-020 (Composition Root), AP-023 (Async), AP-045 (Resource Exhaustion).
  - **Fix decision:** `fix-now` (Slice 2).

- [P1] **BL-CM-03: Потеря `instructions` в `DynamicCodemodeNamespaces`**
  - **Evidence:** `src/runner/codemode-namespaces.ts:34–40`. `desc = def.namespace?.description ?? def.namespace?.instructions` подменяет описание инструкциями, а поле `instructions` остаётся `undefined`.
  - **Impact:** Скрипты `codemode`, вызывающие `describeNamespace()`, теряют операционный контракт и правила работы с инструментами сервера. Системный промпт раздувается в секции заголовка.
  - **Rule:** AP-012 (Контракты метаданных), AP-026 (DTO границы).
  - **Fix decision:** `fix-now` (Slice 3).

- [P1] **BL-CM-04: Синтетический тип экспозиции `"codemode-deferred"` в `tool-adapter.ts`**
  - **Evidence:** `src/runner/tool-adapter.ts:46–56`. Использован несуществующий в каноническом upstream тип `"codemode-deferred"`. При каноническом `exposure === "codemode"` флаг `isDeferred` становится `false`.
  - **Impact:** Инструменты `codemode` не помечаются как `deferred: true` и раздувают системный промпт inline-декларациями, нарушая семантику `searchTools()`.
  - **Rule:** AP-010 (Ports & Adapters), AP-026 (DTO границы), AP-029 (TypeScript Strictness).
  - **Fix decision:** `fix-now` (Slice 4).

- [P1] **BL-CM-08: Игнорирование `AbortSignal` и контекста вызова в `adaptExtensionTool`**
  - **Evidence:** `src/runner/tool-adapter.ts:71–76`. Метод `execute(args, api)` не принимает третий аргумент `context: Context` из Durable и всегда передает `undefined` вместо `signal` в `toolDef.execute`.
  - **Impact:** При остановке хода пользователем (Stop/Abort) или таймаутах сетевые вызовы MCP-инструментов не прерываются и зависают, удерживая сессию.
  - **Rule:** AP-023 (Async дисциплина), AP-045 (Resource exhaustion), AP-047 (Reliable side effects).
  - **Fix decision:** `fix-now` (Slice 5).

- [P1] **BL-CM-05: Отсутствие `quickjs-wasi` в `dependencies` и риск сдувания wasm-кэша**
  - **Evidence:** `package.json:dependencies`. Зависимость `quickjs-wasi` была транзитивной. При чистке кэша коммитов BB папка с `.wasm` исчезала, вызывая фатальный сбой рантайма.
  - **Impact:** Падение `codemode` с ошибкой `Cannot find module 'quickjs-wasi/quickjs.wasm'` у пользователей после обновления плагина.
  - **Rule:** AP-013 (Надежность окружения), AP-020 (Dependency Management).
  - **Fix decision:** `fix-now` (Slice 6).

- [P2] **BL-PI-05: Отсутствие `teardown()` в `subagentsPlugin`**
  - **Evidence:** `src/runner/plugins/built-in/subagents.ts:5–20`. Плагин не вызывает `clearDeliveryHold()`, оставляя зависший флаг доставки при аварийной остановке сессии.
  - **Impact:** Блокировка доставки сообщений курьера после рестарта.
  - **Rule:** AP-013 (Целостность данных), AP-047 (Reliable side effects).
  - **Fix decision:** `fix-now` (Slice 2).

- [P2] **BL-CM-06: Хардкодный префикс `[bb:pi-subagent-mirror:]` в `src/shared/subagent-envelope.ts`**
  - **Evidence:** `src/shared/subagent-envelope.ts:23`. Имя хоста BB захардкожено в доменном слое `shared/`.
  - **Impact:** Утечка концепции хоста в суверенный конверт сообщений, препятствующая использованию рантайма вне Beyond Boundaries.
  - **Rule:** AP-010 (Hexagonal Architecture), AP-025 (Domain Purity).
  - **Fix decision:** `fix-now` (Slice 7).

- [P3] **BL-PI-06: Мёртвые дублирующие импорты в `harness-setup.ts`**
  - **Evidence:** `src/runner/harness-setup.ts:12–18`. Импорты `createCodingTools`, `CodingTools`, `createCodemodeExtension`, `Anchor`, `DefaultCourier` дублируются после перехода на плагины.
  - **Impact:** Засорение пространства имен и путаница в точке инсталляции.
  - **Rule:** AP-015 (DRY, KISS).
  - **Fix decision:** `log-only` (Slice 8).

- [P3] **BL-PI-07: Ослабленная типизация `DurablePluginContext` (`any` index signature)**
  - **Evidence:** `src/runner/plugins/types.ts:3–8`. `registry?: any` и `[key: string]: any`.
  - **Impact:** Ослабление проверок компилятора TypeScript.
  - **Rule:** AP-029 (TypeScript strictness).
  - **Fix decision:** `log-only` (Slice 8).

---

## 4. S5 Triage Gate

| Решение | Находки | Обоснование |
|---|---|---|
| **fix-now** | BL-CM-01, BL-CM-02, BL-CM-03, BL-CM-04, BL-CM-08, BL-CM-05, BL-PI-05, BL-CM-06 | P0, P1 и P2 дефекты, ломающие функционал `codemode`, жизненный цикл, отмену операций и суверенность рантайма. Полная локализация и детерминированная верификация доступны. |
| **log-only** | BL-PI-06, BL-PI-07 | P3 дефекты код-гигиены и типизации, не блокирующие выполнение, но очищаемые попутно в конце цикла. |
| **blocked** | Физическое разделение git-репозиториев | Требует отдельного цикла после стабилизации и релиза v0.4.3. |

---

## 5. S6 Plan Write: Implementation Slices (TDD Red-Green)

### Slice 1: Проброс `structuredOutput` в `tool-adapter.ts` и `extension-mount.ts` (BL-CM-01)
- **Red:** Запустить `node --test tests/codemode-structured-output.test.ts`.  
  *Ожидаемый провал:* `Tool returned no structuredOutput` (`isError: true`).
- **Green:**
  1. В `src/runner/tool-adapter.ts`:
     - Расширить возвращаемый тип `NestedToolExecutor` полем `structuredOutput?: unknown`.
     - В `adaptExtensionTool` извлекать:
       ```ts
       const structuredOutput =
           (result as { structuredContent?: unknown }).structuredContent !== undefined
               ? (result as { structuredContent?: unknown }).structuredContent
               : (result as { structuredOutput?: unknown }).structuredOutput;
       return {
           output: result.content,
           isError: result.isError,
           details: (result.details ?? undefined) as JsonValue | undefined,
           ...(structuredOutput !== undefined ? { structuredOutput: structuredOutput as JsonValue } : {}),
       };
       ```
  2. В `src/runner/extension-mount.ts`:
     - В `createNestedToolExecutor` пробрасывать:
       ```ts
       const structuredOutput =
           (res as { structuredContent?: unknown })?.structuredContent !== undefined
               ? (res as { structuredContent?: unknown }).structuredContent
               : (res as { structuredOutput?: unknown })?.structuredOutput;
       return {
           toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args },
           result: {
               content,
               details: res?.details,
               ...(structuredOutput !== undefined ? { structuredOutput } : {}),
           },
           isError: !!res?.isError,
       };
       ```
- **Boundary & LOC Check:** `node scripts/verify-layer-boundaries.mjs`, `wc -l src/runner/extension-mount.ts src/runner/tool-adapter.ts` (< 250 LOC).
- **Verify:** `node --test tests/codemode-structured-output.test.ts` (PASS).
- **Commit:** `fix(runner): preserve and forward structuredOutput in tool adapter and nested executor`

---

### Slice 2: Замыкание жизненного цикла `teardown()` и очистка QuickJS песочниц (BL-CM-02, BL-PI-05)
- **Red:** Создать `tests/codemode-plugin-lifecycle.test.ts`, тестирующий вызов `pluginRegistry.teardownAll()` при закрытии сессии.  
  *Ожидаемый провал:* `teardown` не вызывается, песочница не уничтожается.
- **Green:**
  1. В `src/runner/plugins/built-in/codemode.ts`:
     - Сохранять `activeSandbox: CodemodeSandbox | undefined`.
     - Реализовать метод `async teardown(): Promise<void> { await activeSandbox?.dispose?.(); activeSandbox = undefined; }`.
  2. В `src/runner/plugins/built-in/subagents.ts`:
     - Реализовать метод `teardown(): void { clearDeliveryHold(); }`.
  3. В `src/runner/harness-setup.ts`:
     - Изменить сигнатуру: `createCodingRegistry(...)` возвращает `Promise<{ registry: Registry; pluginRegistry: DurablePluginRegistry }>`.
  4. В `src/runner/runtime-loader.ts`:
     - Привязать вызов:
       ```ts
       cleanup: async () => {
           await pluginRegistry.teardownAll();
           await mounted.cleanup?.();
       }
       ```
- **Boundary & LOC Check:** `node scripts/verify-layer-boundaries.mjs`, `wc -l src/runner/harness-setup.ts src/runner/runtime-loader.ts` (< 250 LOC).
- **Verify:** `node --test tests/codemode-plugin-lifecycle.test.ts` (PASS).
- **Commit:** `fix(runner): implement teardown in codemode and subagents and bind pluginRegistry to session cleanup`

---

### Slice 3: Корректное разделение `description` и `instructions` в `DynamicCodemodeNamespaces` (BL-CM-03)
- **Red:** Создать `tests/codemode-namespaces-contract.test.ts`.  
  *Ожидаемый провал:* `instructions` undefined в объекте namespace.
- **Green:**
  В `src/runner/codemode-namespaces.ts`:
  ```ts
  this.registerNamespace({
      name: def.namespace?.name ?? serverName,
      prefix,
      ...(def.namespace?.description ? { description: def.namespace.description } : {}),
      ...(def.namespace?.instructions ? { instructions: def.namespace.instructions } : {}),
  });
  ```
- **Boundary & LOC Check:** `node scripts/verify-layer-boundaries.mjs`, `wc -l src/runner/codemode-namespaces.ts` (< 250 LOC).
- **Verify:** `node --test tests/codemode-namespaces-contract.test.ts` (PASS).
- **Commit:** `fix(runner): preserve separate description and instructions in codemode namespaces`

---

### Slice 4: Канонический `ToolExposure` в `tool-adapter.ts` (BL-CM-04)
- **Red:** Создать `tests/tool-adapter-exposure.test.ts`. Проверить предикаты вызова для `"codemode"`, `"deferred"`, `"model-only"`, `"hidden"`.  
  *Ожидаемый провал:* `exposure: "codemode"` не выставляет `isDeferred: true`.
- **Green:**
  В `src/runner/tool-adapter.ts`:
  Удалить `"codemode-deferred"` и выставить канонические флаги:
  ```ts
  const isDeferred = exposure === "deferred" || exposure === "codemode";
  const callers =
      exposure === "model-only" ? (["model"] as const)
      : exposure === "codemode" ? (["tools"] as const)
      : exposure === "hidden" ? ([] as const)
      : (["model", "tools"] as const);
  ```
- **Boundary & LOC Check:** `node scripts/verify-layer-boundaries.mjs`, `wc -l src/runner/tool-adapter.ts` (< 250 LOC).
- **Verify:** `node --test tests/tool-adapter-exposure.test.ts` (PASS).
- **Commit:** `fix(runner): align tool exposure with canonical pi definitions`

---

### Slice 5: Проброс `AbortSignal` в адаптер инструментов (BL-CM-08)
- **Red:** Создать `tests/tool-adapter-abort.test.ts`. Передать AbortSignal в контекст Durable execute и проверить, что `toolDef.execute` получает активный сигнал.  
  *Ожидаемый провал:* `signal` в `toolDef.execute` равен `undefined`.
- **Green:**
  В `src/runner/tool-adapter.ts`:
  Принимать `context: { abortSignal?: AbortSignal }` в `execute(args, api, context)` и пробрасывать `context?.abortSignal`:
  ```ts
  async execute(args, api, runtimeContext) {
      // ...
      const result = await toolDef.execute(
          api.callId,
          args,
          (runtimeContext as { abortSignal?: AbortSignal })?.abortSignal,
          // ...
      );
  }
  ```
- **Boundary & LOC Check:** `node scripts/verify-layer-boundaries.mjs`.
- **Verify:** `node --test tests/tool-adapter-abort.test.ts` (PASS).
- **Commit:** `fix(runner): forward abortSignal from runtimeContext to toolDef execute`

---

### Slice 6: Прямая зависимость `quickjs-wasi: 3.6.2` и бандлирование WASM (BL-CM-05)
- **Red:** Проверить наличие `quickjs-wasi` в `dependencies` `package.json`.
- **Green:**
  1. Добавить `"quickjs-wasi": "3.6.2"` в `dependencies` `package.json`.
  2. Запустить `npm install` для фиксации в `package-lock.json`.
  3. В `scripts/build-runner.mjs` настроить копирование `quickjs.wasm` в `dist/runner/quickjs.wasm` для автономности.
- **Verify:** `npm run build && node -e 'require("quickjs-wasi")'` отрабатывает без ошибок.
- **Commit:** `fix(packaging): add direct quickjs-wasi dependency and bundle wasm assets`

---

### Slice 7: Обобщение конверта зеркала субагентов (BL-CM-06)
- **Red:** Создать `tests/subagent-envelope-generic.test.ts`.  
  Проверить, что парсер поддерживает и новый канонический `[pi:subagent-mirror:v1 ...]`, и легаси `[bb:subagent-mirror:v1 ...]`.
- **Green:**
  В `src/shared/subagent-envelope.ts`:
  ```ts
  const ENVELOPE_REGEX = /^\s*\[(?:pi|bb):subagent-mirror:v1\s+session=([^\s\]]+)\s+parent=([^\s\]]+)\s+conv=([^\s\]]+)\]\s*(?:\r?\n)?([\s\S]*)$/u;
  export function formatSubagentMirrorPrompt(sessionKey: string, parentThreadId: string, conversationId: string, task: string): string {
      return `[pi:subagent-mirror:v1 session=${sessionKey} parent=${parentThreadId} conv=${conversationId}]\n${task.trim()}`;
  }
  ```
- **Boundary & LOC Check:** `node scripts/verify-layer-boundaries.mjs`.
- **Verify:** `node --test tests/subagent-envelope-generic.test.ts` (PASS).
- **Commit:** `refactor(shared): generalize subagent mirror envelope to sovereign pi prefix`

---

### Slice 8: Код-гигиена и строгая типизация (BL-PI-06, BL-PI-07)
- **Green:**
  1. Удалить мертвые неиспользуемые импорты инструментов в `src/runner/harness-setup.ts`.
  2. В `src/runner/plugins/types.ts` уточнить типизацию `DurablePluginContext` (`registry?: Registry`, убрать `[key: string]: any`).
- **Verify:** `npm run build` (PASS).
- **Commit:** `refactor(runner): clean up unused imports and tighten plugin context typing`

---

## 6. S9 Verify Gate: Two-Circuit Parallel Verification Gate

По завершении всех 8 срезов запускаются обязательные строгие проверки:

1. **Контур 1: Архитектурный контроль (Architectural Reviewer):**
   - `node scripts/verify-layer-boundaries.mjs` — **СТРОГО 0 нарушений** границ Host <-> Runner.
   - `node scripts/verify-import-graph.mjs` — **СТРОГО 0 циклов** импорта.
   - `npm run test:contracts` — **Negative guard TS2322 PASS**, 0 type errors.
   - Проверка лимитов строк: `wc -l` всех измененных файлов — **СТРОГО < 250 LOC** (AP-019).
2. **Контур 2: Продуктовый и тестовый контроль (Product Reviewer):**
   - Полный тестовый сьют: `npm test` — **все 740+ тестов PASS, 0 fail**.
   - Диагностический скрипт: `node --import tsx scripts/diagnose-codemode.ts` — **100% PASS** (Diagnostic 1 и Diagnostic 2 проходят чисто).
   - Проверка здоровья: `npm run doctor` — **HEALTHY (PASS)**.

---

## 7. S10 Ledger Update & S11 Learn Gate

- Поднять версию в `package.json` и `package-lock.json` до `0.4.3`.
- Пересобрать релизные артефакты: `npm run build`.
- Внести подробную запись в `docs/arch-improvement/ledger.md` по каноническому формату Cycle 102.
- Внести запись в `docs/arch-improvement/memory.md` с долгосрочными архитектурными уроками.
- Закоммитить и поставить релизный тег `v0.4.3`.
