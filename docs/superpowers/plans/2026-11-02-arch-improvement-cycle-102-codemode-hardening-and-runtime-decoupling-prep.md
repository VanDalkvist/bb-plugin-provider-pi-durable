# Arch Improvement Cycle 102: Codemode Hardening & Sovereign Runtime Decoupling Preparation

**Cycle:** 102  
**Date:** 2026-11-02  
**Goal:** Полное устранение всех 4 дефектов подсистемы Codemode (BL-CM-01..BL-CM-04), гарантированное бандлирование `quickjs-wasi` (BL-CM-05) во избежание сдувания wasm-кэша, очистка остаточных префиксов `bb:` в конвертах субагентов (BL-CM-06) и подготовка 100% чистых границ для физического выделения `pi-durable-runtime` в отдельный репозиторий.  
**PRD / Context Map:** `docs/superpowers/specs/2026-11-02-prd-pi-durable-sovereign-runtime-and-sdk-decoupling.md`  
**Audit Artifact:** `docs/arch-improvement/audits/2026-11-01-builtin-plugins-and-codemode-audit.md`  
**Parent Orchestration Contract:** `/Users/vanya/Projects/AGENTS.md` (Strict Timeouts, Zero Layer Leaks, TDD Red-Green).

---

## 1. Selected Findings & Triage

| ID | Уровень | Компонент / Файл | Суть дефекта | Решение (Triage) |
|---|---|---|---|---|
| **BL-CM-01** | P0 | `src/runner/extension-mount.ts:65`, `src/runner/tool-adapter.ts:115` | `createNestedToolExecutor` и `adaptExtensionTool` отбрасывают `structuredOutput` / `structuredContent`, возвращая в QuickJS сырой текст. Песочница теряет типизированные объекты. | **fix-now (Slice 1)** |
| **BL-CM-02** | P0 | `src/runner/plugins/built-in/codemode.ts:5` | Отсутствие `teardown()` в `codemodePlugin`. `CodemodeSandbox` никогда не уничтожается вызовом `dispose()`, вызывая утечки памяти QuickJS. | **fix-now (Slice 2)** |
| **BL-CM-03** | P1 | `src/runner/codemode-namespaces.ts:36` | `registerFromToolDefinitions` заменяет `description` на `description ?? instructions`, оставляя поле `instructions` пустым в системном промпте секции `<codemode>`. | **fix-now (Slice 3)** |
| **BL-CM-04** | P1 | `src/runner/tool-adapter.ts:53` | Синтетический тип `"codemode-deferred"`, отсутствующий в `ToolExposure` канонического `pi-coding-agent`, ломал предикаты фильтрации `agent.callable`. | **fix-now (Slice 4)** |
| **BL-CM-05** | P1 | `package.json` | `quickjs-wasi` отсутствует в прямых `dependencies`, из-за чего при чистке кэша BB файл `quickjs.wasm` пропадал с диска, вызывая фатальный краш загрузки QuickJS. | **fix-now (Slice 5)** |
| **BL-CM-06** | P2 | `src/shared/subagent-envelope.ts:23` | Хардкодный префикс `[bb:pi-subagent-mirror:v1...]` в доменном слое `shared/`. Требуется обобщить до нейтрального `[pi:subagent-mirror:v1...]` с поддержкой обратной совместимости. | **fix-now (Slice 6)** |

---

## 2. Hard Architecture Invariants (Zero Leaks)

1. **Firewall Invariant (AP-010, AP-025):**  
   `src/runner/` строго **0 импортов** из `src/host/`.  
   `src/host/` строго **0 импортов** из `src/runner/`.  
   `src/contracts/` строго **0 импортов** из `runner/` и `host/`.  
   Проверяется запуском `node scripts/verify-layer-boundaries.mjs` на каждом шаге.
2. **Strict Test Timeouts (AP-013, AP-028):**  
   Любой тест или команда обязаны иметь явный таймаут (`{ timeout: 5000 }` в `node:test` и `timeout: 15` в shell). Категорически запрещены висящие eval-скрипты.
3. **Line Budgets (AP-019):**  
   100% файлов `.ts` строго < 250 LOC (целевой soft ceiling: 200 LOC).

---

## 3. Implementation Slices (TDD: Red -> Green -> Verify -> Commit)

### Slice 1: Проброс `structuredOutput` в `createNestedToolExecutor` и `adaptExtensionTool` (BL-CM-01)
- [ ] **Red:** Создать `tests/codemode-structured-output.test.ts`.  
  Проверить, что инструмент, возвращающий `{ output: [...], structuredContent: { foo: "bar", count: 42 } }`, при вызове через `createNestedToolExecutor` возвращает в ответе свойство `structuredOutput` (или `result.structuredContent`), и QuickJS-песочница получает валидный объект.  
  *Ожидаемый провал:* Тест падает, так как сейчас `structuredOutput` отбрасывается.
- [ ] **Green:** В `src/runner/extension-mount.ts` (функция `createNestedToolExecutor`) и `src/runner/tool-adapter.ts` добавить проброс:
  ```ts
  const structuredOutput = (res as any)?.structuredContent ?? (res as any)?.structuredOutput;
  return {
      toolCall: ...,
      result: {
          content,
          details: res?.details,
          ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      },
      isError: !!res?.isError,
  };
  ```
- [ ] **Verify:** `node --test tests/codemode-structured-output.test.ts` проходит (PASS).
- [ ] **Commit:** `fix(runner): preserve and forward structuredOutput in nested tool executor`

---

### Slice 2: Реализация `teardown()` в `codemodePlugin` и привязка `pluginRegistry` к жизненному циклу (BL-CM-02, BL-PI-05)
- [ ] **Red:** Создать `tests/codemode-plugin-lifecycle.test.ts`.  
  Проверить, что при вызове `pluginRegistry.teardownAll()` экземпляр `CodemodeSandbox` вызывает свой метод `dispose()` и освобождает дескрипторы WASM, а `subagentsPlugin` сбрасывает delivery hold.  
  *Ожидаемый провал:* `codemodePlugin.teardown` undefined.
- [ ] **Green:** 
  1. В `src/runner/plugins/built-in/codemode.ts`:
     Сохранять созданный экземпляр `CodemodeSandbox` в замыкании модуля и экспортировать метод `teardown(): void { activeSandbox?.dispose?.(); activeSandbox = undefined; }`.
  2. В `src/runner/plugins/built-in/subagents.ts`:
     Экспортировать метод `teardown(): void { clearDeliveryHold(); }`.
  3. В `src/runner/harness-setup.ts`:
     Возвращать `{ registry, pluginRegistry }` из `createCodingRegistry`.
  4. В `src/runner/runtime-loader.ts`:
     Объединить `mounted.cleanup` и `pluginRegistry.teardownAll()` в единый `cleanup: async () => { await pluginRegistry.teardownAll(); await mounted.cleanup(); }`.
- [ ] **Verify:** `node --test tests/codemode-plugin-lifecycle.test.ts` проходит (PASS).
- [ ] **Commit:** `fix(runner): implement teardown in codemode and wire pluginRegistry to session cleanup`

---

### Slice 3: Корректное разделение `description` и `instructions` в `DynamicCodemodeNamespaces` (BL-CM-03)
- [ ] **Red:** Создать `tests/codemode-namespaces-contract.test.ts`.  
  Передать инструменту `def.namespace = { name: "test", description: "Test Server", instructions: "Use this for tests" }`. Проверить, что в `getNamespaces()[0]` поле `description === "Test Server"` и `instructions === "Use this for tests"`.  
  *Ожидаемый провал:* `instructions` undefined, `description` содержит instructions.
- [ ] **Green:** В `src/runner/codemode-namespaces.ts`:
  Раздельно пробрасывать поля без подмены:
  ```ts
  this.registerNamespace({
      name: def.namespace?.name ?? serverName,
      prefix,
      ...(def.namespace?.description ? { description: def.namespace.description } : {}),
      ...(def.namespace?.instructions ? { instructions: def.namespace.instructions } : {}),
  });
  ```
- [ ] **Verify:** `node --test tests/codemode-namespaces-contract.test.ts` проходит (PASS).
- [ ] **Commit:** `fix(runner): separate namespace description and instructions in codemode namespaces`

---

### Slice 4: Ликвидация синтетического `"codemode-deferred"` в `tool-adapter.ts` (BL-CM-04)
- [ ] **Red:** Создать `tests/tool-adapter-exposure.test.ts`.  
  Проверить, что инструмент с каноническим `exposure: "deferred"` помечается как `deferred: true` и доступен в `callers: ["tools"]`.
- [ ] **Green:** В `src/runner/tool-adapter.ts`:
  Заменить проверки:
  ```ts
  const isDeferred = exposure === "deferred";
  const callers =
      exposure === "model-only" ? (["model"] as const)
      : exposure === "codemode" ? (["tools"] as const)
      : exposure === "hidden" ? ([] as const)
      : (["model", "tools"] as const);
  ```
- [ ] **Verify:** `node --test tests/tool-adapter-exposure.test.ts` проходит (PASS).
- [ ] **Commit:** `fix(runner): align tool exposure with canonical pi-coding-agent definitions`

---

### Slice 5: Прямая зависимость `quickjs-wasi` и бандлирование WASM (BL-CM-05)
- [ ] **Red:** Проверить наличие `quickjs-wasi` в `package.json`.  
- [ ] **Green:** 
  1. Добавить `"quickjs-wasi": "3.6.2"` в `dependencies` `package.json`.
  2. Запустить `npm install` для обновления `package-lock.json`.
  3. В `scripts/build-runner.mjs` добавить копирование `quickjs.wasm` в `dist/runner/quickjs.wasm` (или настроить резолюцию путей).
- [ ] **Verify:** `npm run build && node -e 'require("quickjs-wasi")'` отрабатывает без ошибок.
- [ ] **Commit:** `fix(packaging): add direct quickjs-wasi dependency and bundle wasm assets`

---

### Slice 6: Обобщение конверта субагентов (BL-CM-06)
- [ ] **Red:** Создать `tests/subagent-envelope-generic.test.ts`.  
  Проверить, что `formatSubagentMirrorPrompt` генерирует `[pi:subagent-mirror:v1 ...]`, а `parseSubagentMirrorPrompt` бесшовно понимает и `pi:`, и устаревший `bb:`.
- [ ] **Green:** В `src/shared/subagent-envelope.ts`:
  Обновить регулярное выражение для поддержки `(?:pi|bb)`:
  ```ts
  const ENVELOPE_REGEX = /^\s*\[(?:pi|bb):subagent-mirror:v1\s+session=([^\s\]]+)\s+parent=([^\s\]]+)\s+conv=([^\s\]]+)\]\s*(?:\r?\n)?([\s\S]*)$/u;
  export function formatSubagentMirrorPrompt(sessionKey: string, parentThreadId: string, conversationId: string, task: string): string {
      return `[pi:subagent-mirror:v1 session=${sessionKey} parent=${parentThreadId} conv=${conversationId}]\n${task.trim()}`;
  }
  ```
- [ ] **Verify:** `node --test tests/subagent-envelope-generic.test.ts` проходит (PASS).
- [ ] **Commit:** `refactor(shared): generalize subagent mirror envelope to sovereign pi prefix`

---

## 4. Двухконтурная верификация S9 (Two-Circuit Verification Gate)

Перед релизом v0.4.3 запускаются обязательные проверки:
1. **Контур 1 (Архитектурный фаервол и типы):**
   - `node scripts/verify-layer-boundaries.mjs` — 0 boundary leaks.
   - `node scripts/verify-import-graph.mjs` — 0 cycles.
   - `npm run test:contracts` — 0 contract errors, TS2322 negative guard pass.
   - `wc -l` на всех затронутых файлах — строго < 250 LOC (AP-019).
2. **Контур 2 (Тестовый сьют и регрессионный контроль):**
   - Полный прогон: `npm test` (все 740+ тестов pass, 0 fail).
   - Проверка работоспособности QuickJS codemode: `npm run doctor` (PASSED / Healthy).

---

## 5. Выпуск релиза и обновление леджеров (S10, S11)

- Поднять версию в `package.json` и `package-lock.json` до `0.4.3`.
- Пересобрать бандлы: `npm run build`.
- Обновить `docs/arch-improvement/ledger.md` (добавить секцию Cycle 102).
- Обновить `docs/arch-improvement/memory.md` (зафиксировать долгосрочные выводы по WASM-кэшированию и QuickJS-песочницам).
- Закоммитить и создать релизный тег `v0.4.3`.
