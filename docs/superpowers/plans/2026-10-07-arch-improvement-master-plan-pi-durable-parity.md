# Master Architectural Implementation Plan: Remediation & Full Parity of Pi Durable in BB IDE

**Document ID:** `plans/pi-durable-bb-provider-arch-master-plan`  
**Version:** 4.0.0 (Master Unified Roadmap: Full Audit Reconciliation, 4 Territories & Extended Parity)  
**Current Release:** `v0.2.11` (Commit: `1b89f6a`)  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Upstream Engine:** `@earendil-works/pi-durable` v1.0.4 & `@earendil-works/pi-coding-agent` v1.0.4  
**Host Target:** Beyond Boundaries (BB IDE) `>= 0.45`  
**Status:**
- **Stage 1 (Foundation Hardening, Territory Decoupling & Host Parity):** ✅ 100% COMPLETED (Cycles 56–66, Releases `v0.2.1` – `v0.2.11`)
- **Stage 2 (Advanced Engine Capabilities & Extended Parity):** ⏳ IN PROGRESS / PLANNED (Cycles 67–75)

---

## 1. Architectural Guardrails & The Four Territories Invariant

### 1.1 The Four Territories Architectural Boundary
A foundational invariant of `bb-plugin-provider-pi-durable` is that **it functions strictly as a thin bidirectional GoF Adapter** between BB IDE and the Pi Durable engine, with zero foreign domain ownership:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Territory 1: BB IDE (Host & UI Surface)                                │
│ • Contracts: Plugin SDK, JSON-RPC (turn/start, turn/steer, thread/stop)│
│ • UI widgets: diff viewer, thinking accordion, context window meter    │
│ • Invariant: Reasoning operations are collapsed-by-default by design   │
│ • Presentation: { label, icon, title, detail, suppress, tint, badge }  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ (JSON-RPC stdio)
┌──────────────────────────────────▼─────────────────────────────────────┐
│ Territory 4: The Provider Plugin (bb-plugin-provider-pi-durable)       │
│ • SOLE LEGITIMATE ROLE: Pure Bidirectional Adapter (GoF Adapter)       │
│ • Translates BB JSON-RPC requests ──► Pi Durable Harness commands      │
│ • Translates FSM AgentEvent/docs ──► BB WireEvents & chat deltas       │
│ • DOES NOT OWN: prompt texts, agent rules, or core domain mechanics    │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │                                 │
                   │ (Durable API)                   │ (Settings & Ext)
┌──────────────────▼───────────────┐ ┌───────────────▼───────────────────┐
│ Territory 2: Pi Durable Core    │ │ Territory 3: Pi Ecosystem / CLI   │
│ (@earendil-works/pi-durable)     │ │ (@earendil-works/pi-coding-agent) │
│ • FSM tasks (Generation, Tool)   │ │ • SettingsManager, MCP discovery  │
│ • ACID SQLite WAL persistence    │ │ • ModelRuntime, provider catalogs │
│ • CoW forks, document mounts     │ │ • Tool definitions, skills, rules │
│ • Deterministic replay           │ │ • ~/.pi/agent/settings.json       │
└──────────────────────────────────┘ └──────────────────────────────────┘
```

### 1.2 Upstream Prototype Quarantine (`src/runner/upstream/`)
Because `@earendil-works/pi-durable` is an execution engine rather than an agent application, certain glue primitives (e.g., multi-process SQLite session directory locking, foreground subagents) exist upstream only in `packages/coding-agent/src/experimental/durable/`. All such unexported upstream prototypes are quarantined into `src/runner/upstream/` with explicit provenance documentation.

### 1.3 Key AP Architectural Invariants (AP-010 – AP-071)
1. **AP-010 (Modular Monolith & Territory Boundaries):** Domain/application layers never import infrastructure directly; composition root wires ports to adapters.
2. **AP-012 (Fail-Fast & Explicit Contracts):** No loose type fallbacks; invalid states or tool failures throw or emit typed errors.
3. **AP-013 (Data Integrity without Fakes):** Strictly prohibited to forge fake completions, fake fork sessions, fake token sums, or fake tool results. Every state originates from SQLite / Chord transactions.
4. **AP-019 (Modularity & File Line Budgets):** Soft limit 150 lines, hard limit 250 lines per `.ts` file. 1 file = 1 responsibility + 1 primary export.
5. **AP-020 (Composition Root):** System wiring happens strictly in `src/host/index.ts` and `src/runner/index.ts`.
6. **AP-021 (Thin Entry Points):** Handlers only validate input, call use-cases, and return DTOs.
7. **AP-022 (Typed Errors):** Zero empty catch blocks; all errors logged with structured context or wrapped into typed errors.
8. **AP-026 (DTO Boundaries):** Strict DTO interfaces and Zod schemas for all inter-process IPC messages.
9. **AP-028 (Deterministic Testing):** Behavioral fixes follow TDD with deterministic assertions.
10. **AP-029 (Strict TypeScript):** Zero `as any` type-casts; no constructor parameter properties (Node 26 type stripping compatibility).
11. **AP-033 / AP-034 (Database Atomicity & Concurrency):** All session writes pass through ACID SQLite/Chord transactions with stale lock protection.

---

## 2. The 15 Divergences & Community Defects Status Matrix

| ID | Область | Нативное ядро `@earendil-works/pi-durable` / BB Protocol | Текущий статус в провайдере | Релиз / Цикл |
|---|---|---|---|---|
| **D-1** | **Очистка блокировки при выходе** | `durable.close()` освобождает `proper-lockfile` без 10-сек задержки | ✅ **FIXED** (Awaits `durable.close()` на SIGTERM/SIGINT) | `v0.2.1` (Cycle 56) |
| **D-2** | **Пути к сессиям SQLite** | Сессии хранятся как папки `${sanitizedThreadId}/session.sqlite` | ✅ **FIXED** (Устранен суффикс `.jsonl` из путей) | `v0.2.1` (Cycle 56) |
| **D-3** | **Пропуск событий `AgentEvent`** | `watchEvents` эмитит `snapshot`, `auto_retry`, `deferred_poll` | ⏳ **PARTIAL / PLANNED** (Обработка `snapshot` и `auto_retry`) | Stage 2 (Cycle 68) |
| **D-4** | **Схлопывание `contentIndex`** | `message_update` содержит `change.contentIndex` для каждого блока | ✅ **FIXED** (Динамический `contentIndex` и каналы `thinking-${idx}`) | `v0.2.8` (Cycle 63), `v0.2.10` (Cycle 65) |
| **D-5** | **Маскирование сбоев тулов** | `event.entry` равен `undefined`, если задача тула упала | ⏳ **PLANNED** (Устранить маскирование сбоев тулов как успехов) | Stage 2 (Cycle 67) |
| **D-6** | **Потеря метаданных Diff** | `CodingTools.edit` возвращает `details: { diff, patch }` | ⏳ **PLANNED** (Проброс патчей в BB Diff Viewer) | Stage 2 (Cycle 67) |
| **D-7** | **Фальсификация кумулятивного расхода** | `pi.usage` накапливает кумулятивный расход сессии | ⏳ **PLANNED** (Монотонный подсчет totalTokens из документа usage) | Stage 2 (Cycle 69) |
| **D-8** | **Краш моделей без reasoning** | `setThinkingLevel` выбрасывает ошибку при `!model.reasoning` | ✅ **FIXED** (Безопасный фоллбек и фильтрация thinkingLevel) | `v0.2.8` (Cycle 63), `v0.2.10` (Cycle 65) |
| **D-9** | **Обрезка вывода тулов и диагностики** | `tool_execution_update` передает `trimStart` и `diagnostics` | ⏳ **PLANNED** (Проброс `trimStart` и диагностических предупреждений) | Stage 2 (Cycle 67) |
| **D-10**| **Обработка `snapshot` при старте** | При старте `watchEvents` первым приходит снимок состояния | ⏳ **PLANNED** (Восстановление активных слотов из `snapshot`) | Stage 2 (Cycle 68) |
| **D-11**| **Чекпоинты в `turn.boundary`** | Каждый ход завершается атомарным `EntryId` для rewind/fork | ⏳ **PLANNED** (Передача `providerCheckpointId` в `turn.boundary`) | Stage 2 (Cycle 68) |
| **D-12**| **Отображение цепочки мыслей** | Потоковая передача `thinking_delta`, аккордеон с Brain-иконкой | ✅ **FIXED** (Brain icon, streaming `reasoningText`, lifecycle closure) | `v0.2.8`–`v0.2.11` (Cycles 63–66) |
| **D-13**| **Молчаливые системные сбои** | При краше раннера или ошибке CWD эмитится `provider.error` | ✅ **FIXED** (`child.on("error")`, fail-fast start, `settlesTurn: true`) | `v0.2.1` (Cycle 56) |
| **D-14**| **Синхронизация Context Meter** | Точный учет контекстного окна модели в реальном времени | ✅ **FIXED** (Синхронный эмит `contextWindow` на `agent_end`) | `v0.2.2` (Cycle 57), `v0.2.4` (Cycle 59) |
| **D-15**| **Невидимость тулов `edit`/`write` и зависание steer** | `write` -> `add`, `edit` -> `update`; steer без `providerTurnId` | ✅ **FIXED** (Zod-валидные дельты, исключение 409-конфликта) | `v0.2.3` (Cycle 58) |

### Реестр устранённых дефектов сообщества (GitHub Issues)
* **Issue #1 (CWD Hijacking):** Устранено несанкционированное переопределение рабочего каталога через `--session-dir` (Cycle 56, `v0.2.1`).
* **Issue #2 (Runner Discovery):** Внедрен 6-уровневый переносимый поиск раннера в хост-кеше BB через `node:sqlite` (Cycle 56, `v0.2.1`).
* **Issue #3 (Premature Readiness):** Ликвидирован фальшивый ready-сигнал до завершения инициализации SQLite (Cycle 56, `v0.2.1`).
* **Issue #4 (Context Meter at 0):** Исправлена распаковка вложенных ответов RPC и гонка закрытия хода до обновления контекста (Cycle 57, `v0.2.2` и Cycle 59, `v0.2.4`).
* **Issue #5 (Steer Pending Freeze):** Устранен 409-конфликт `MissingStoredTurnStartedError` путем исключения `providerTurnId` из `input.accepted` (Cycle 58, `v0.2.3`).
* **Issue #6 (Edit/Write Invisibility):** Дельты инструментов согласованы со схемой `fileChange` (`kind: "add" | "update"` с гранулярными правками) (Cycle 58, `v0.2.3`).
* **Issue #7 (Self-Referential Bundling):** `bb.server` в `package.json` переведён на исходный `./server.ts`, устранив циклический бандлинг устаревших артефактов (Cycle 64, `v0.2.9`).
* **Issue #8 (Dropped Thinking Level):** `harness.root()` и `root.configure()` снабжены явной передачей `thinkingLevel` из параметров хода (Cycle 65, `v0.2.10`).
* **Issue #9 (Dead Setting Invariant):** Удалена холостая настройка `openThinkingByDefault` после доказательства захардкоженного поведения BB IDE (Cycle 66, `v0.2.11`).

---

## 3. Обзор дорожной карты: Stage 1 и Stage 2

```
STAGE 1: ФУНДАМЕНТАЛЬНОЕ УКРЕПЛЕНИЕ, ВЫРАВНИВАНИЕ ТЕРРИТОРИЙ И ПАРИТЕТ ХОСТА (Cycles 56–66) [✅ ЗАВЕРШЕНО]
  - Cycle 56: Жизненный цикл процессов, снятие lockfile и нормализация путей (v0.2.1)
  - Cycle 57: Телеметрия контекстного окна и синхронизация usage (v0.2.2)
  - Cycle 58: Телеметрия инструментов edit/write и протокол steer (v0.2.3)
  - Cycle 59: Синхронный эмит счетчика контекста на agent_end (v0.2.4)
  - Cycle 60: Прозрачная фабрика расширений Pi (codemode, mcp, tool-search) (v0.2.5)
  - Cycle 60.1: Горячий фикс динамической синхронизации MCP и контекста codemode (v0.2.6)
  - Cycle 61: Архитектурное выравнивание 4 территорий и очистка промпта (v0.2.7)
  - Cycle 62: Модуляризация хост-слоя (<150 строк) и строгая типизация моста (v0.2.7)
  - Cycle 63: Brain-аккордеон рассуждений и декларативные настройки (v0.2.8)
  - Cycle 64: Коррекция точки входа манифеста server.ts для активации настроек (v0.2.9)
  - Cycle 65: Инициализация уровня размышлений в Durable FSM и закрытие каналов (v0.2.10)
  - Cycle 66: Ревизия протокола BB и выпиливание холостой настройки openThinkingByDefault (v0.2.11)

STAGE 2: РАСШИРЕННЫЕ ВОЗМОЖНОСТИ ДВИЖКА И ПОЛНЫЙ ПАРИТЕТ С ПЛАТФОРМОЙ (Cycles 67–75) [⏳ В РАБОТЕ]
  - Cycle 67: Отказоустойчивость тулов, diff-метаданные и диагностики вывода (D-5, D-6, D-9)
  - Cycle 68: Извлечение чекпоинтов SQLite, обработка snapshot и turn.boundary (D-3, D-10, D-11)
  - Cycle 69: Монотонный учет кумулятивного расхода токенов через pi.usage (D-7)
  - Cycle 70: Чекпоинт-форки тредов, перемотка истории и редактирование сообщений (thread/fork)
  - Cycle 71: Визуальные карточки сабагентов и иерархия делегирования (type: "delegation")
  - Cycle 72: Детальная разбивка затрат и провайдер usage (provider/usage)
  - Cycle 73: Синхронизация графа задач в реальном времени (harness.taskGraph())
  - Cycle 74: Расширенная очередь сообщений inbox и отмена задач (submission.abort)
  - Cycle 75: Кастомные документы Durable Chord и мастер-конформность
```

---

## 4. Спецификации завершённых циклов (Stage 1: Cycles 56–66)

### Cycle 56: Process Lifecycle, Lock Cleanup & Session Path Normalization [✅ COMPLETED — v0.2.1]
- **Коммиты:** `f4b685e`, `969b180` | **Тесты:** 34 / 34 pass.
- **Реализация:**
  1. Внедрен graceful shutdown: `SIGTERM`/`SIGINT`/`stdin.end` ожидают `await activeDurable.close()`, мгновенно снимая `proper-lockfile` без 10-секундного зависания.
  2. Нормализованы пути сессий: исключен суффикс `.jsonl`.
  3. Внедрен 6-уровневый переносимый поиск раннера в хост-кеше BB через `node:sqlite`.
  4. Атомарный анонс готовности раннера strictly после инициализации SQLite.
  5. Декомпозиция `runtime.ts` (430 строк) на модули < 250 строк по AP-019.

### Cycle 57: Context Window Telemetry & Usage Synchronization [✅ COMPLETED — v0.2.2]
- **Коммит:** `42d48ae` | **Тесты:** 40 / 40 pass.
- **Реализация:**
  1. Исправлена распаковка вложенного ответа `requestOk` для `{ data: { contextUsage } }`.
  2. Гарантирован вызов `refreshContextUsage()` строго до отправки `turn.boundary` на событии `agent_end`.
  3. Добавлен фоллбек определения модели при инициализации сессии.
  4. Проброс `contextWindow` через адаптер событий в дельты ленты.

### Cycle 58: Tool Telemetry & Steer Protocol Integrity [✅ COMPLETED — v0.2.3]
- **Коммит:** `eae5c31` | **Тесты:** 43 / 43 pass.
- **Реализация:**
  1. Согласование схемы инструментов: `write` транслируется в `kind: "add"`, `edit` в `kind: "update"` с массивом `edits: [{ oldText, newText }]`, восстановив отображение диффов в UI BB.
  2. Исключен `providerTurnId` из `input.accepted` при `turn/steer`, устранив ошибку 409 `MissingStoredTurnStartedError` и зависание сообщений в `Steer pending`.

### Cycle 59: Context Window Meter Synchronization [✅ COMPLETED — v0.2.4]
- **Коммит:** `2502690` | **Тесты:** 43 / 43 pass.
- **Реализация:**
  1. В `DeltaTranslator` добавлен синхронный эмит дельты `contextWindow` (`used`, `size`, `estimated: false`) напрямую на событии `agent_end`.
  2. Ликвидирована гонка между асинхронным IPC опросом счетчика и рендерингом UI, гарантировав мгновенное обновление индикатора контекста.

### Cycle 60 & 60.1: Transparent Extension Foundation & Dynamic MCP Support [✅ COMPLETED — v0.2.5, v0.2.6]
- **Коммиты:** `483fa2e`, `e819b10` | **Тесты:** 47 / 47 pass.
- **Реализация:**
  1. Реализован архитектурный контракт Thin Bridge: стандартные фабрики `createCodemodeExtension`, `createMcpExtension`, `createToolSearchExtension` передаются в `DefaultResourceLoader`.
  2. Создан `src/runner/extension-bridge.ts` для адаптации `ToolDefinition` к `ToolRegistration` ядра Durable.
  3. В `v0.2.6` устранен сбой вложенного контекста codemode (`createToolContext`, `getCallableTools`), включен `isProjectTrusted: true` для `mcp.json` и поддержана динамическая синхронизация через `refreshTools`.

### Cycle 61: Territory Realignment & Decoupling [✅ COMPLETED — v0.2.7]
- **Коммит:** `ecd7b99` | **Тесты:** 54 / 54 pass.
- **Реализация:**
  1. Четкая изоляция 4 территорий: BB IDE, Pi Durable Core, Pi Ecosystem, Provider Plugin.
  2. Очищен `prompt.ts`: удален хардкод сниппетов и правил; тулы и контекст динамически читаются из `@earendil-works/pi-coding-agent`.
  3. Неэкспортированные прототипы апстрима (`subagent.ts`, `sessions.ts`) изолированы в `src/runner/upstream/`.

### Cycle 62: Host Modularity & Bridge Type Safety [✅ COMPLETED — v0.2.7]
- **Коммит:** `85feaba` | **Тесты:** 54 / 54 pass.
- **Реализация:**
  1. Декомпозиция хост-слоя на независимые модули < 150 строк: `bridge-router.ts`, `message-delta-translator.ts`, `runner-rpc-channel.ts`, `session-telemetry.ts`.
  2. Ликвидированы 12 небезопасных приведений `as any` через строгие тайпгарды Durable-документов (`isAgentDocument`, `isUsageDocument`).

### Cycle 63: Brain-Icon Collapsible Thinking & Settings [✅ COMPLETED — v0.2.8]
- **Коммит:** `0129bf5` | **Тесты:** 59 / 59 pass.
- **Реализация:**
  1. Внедрена презентация рассуждений с иконкой мозга `Brain` (`label: { pending: "Thinking", completed: "Thought" }, icon: { glyph: "Brain" }`).
  2. Потоковая передача чанков рассуждений по каналу `reasoningText` с открытием `thinking-${idx}`.
  3. Декларативные настройки плагина через `bb.settings.define`.

### Cycle 64: Server Manifest Entrypoint & Settings Activation [✅ COMPLETED — v0.2.9]
- **Коммит:** `6e5682e` | **Тесты:** 59 / 59 pass.
- **Реализация:**
  1. Исправлен путь точки входа `"bb.server"` в `package.json` с `./dist/server.js` на исходный `./server.ts`.
  2. Устранен циклический бандлинг устаревших файлов при `bb plugin build`; настройки активированы в CLI (`bb plugin config`).

### Cycle 65: Durable Thinking Level Initialization & Lifecycle Parity [✅ COMPLETED — v0.2.10]
- **Коммит:** `e9aa12e` | **Тесты:** 63 / 63 pass.
- **Реализация:**
  1. `harness.root()` и резюм сессий снабжены явной передачей `thinkingLevel` из параметров хода.
  2. В `BBEventAdapter` внедрен метод `closeThinkingIfNeeded()`, гарантирующий закрытие потока мыслей на переходах к тексту, тулам или концу хода.
  3. В `message-delta-translator.ts` реализован фоллбек закрытия незакрытых каналов мыслей.

### Cycle 66: Retirement of Unsupported Settings & Host Realignment [✅ COMPLETED — v0.2.11]
- **Коммит:** `1b89f6a` | **Тесты:** 63 / 63 pass.
- **Реализация:**
  1. Проведен глубокий аудит исходного кода хоста BB IDE (`start-server.js` и `workspace-checkout-display`), доказавший, что строки рассуждений (`operationKind: "reasoning"`) архитектурно захардкожены на состояние «свернуто по умолчанию» (collapsed by default).
  2. Холостая настройка `openThinkingByDefault` выпилена из `server.ts` и тестов во избежание создания ложных ожиданий.
  3. Сохранена и подтверждена реально работающая настройка `hideThinking` (через `suppress: true`). Достигнут 100% паритет с нативным `provider-pi`.

---

## 5. Спецификации предстоящих циклов (Stage 2: Cycles 67–75)

---

### Cycle 67: Tool Fault Integrity, Output Diagnostics & Diff Metadata (D-5, D-6, D-9)
- **Целевые расхождения:** D-5, D-6, D-9 (AP-012, AP-013, AP-026).
- **Проблема:**
  1. При сбое или падении задачи инструмента `event.entry` равен `undefined`, что ошибочно интерпретируется в `bb-event-adapter.ts` как `isError: false`, рапортуя фатальный краш тула как успех (D-5).
  2. Инструмент `edit` возвращает `details: { diff, patch }`, но `bb-event-adapter.ts` отбрасывает их, лишая Diff Viewer возможности точного отображения патча (D-6).
  3. `tool_execution_update` игнорирует `trimStart` и отбрасывает диагностические предупреждения (D-9).
- **Решение:**
  1. В `bb-event-adapter.ts` при `event.entry === undefined` в `tool_execution_end` принудительно устанавливать `isError: true` с диагностикой `"Tool execution faulted or was orphaned"`.
  2. Пробрасывать `event.details` через `BBWireEvent` в `tool-delta-translator.ts`.
  3. Поддержать передачу `trimStart` и диагностик тула в выходной поток дельт.
- **Файлы:** `src/runner/bridge/bb-event-adapter.ts`, `src/host/tool-delta-translator.ts`, `tests/tool-fault-and-diff.test.ts`.

---

### Cycle 68: Checkpoint Extraction, Native Event Stream & `turn.boundary` Parity (D-3, D-10, D-11)
- **Целевые расхождения:** D-3, D-10, D-11 (AP-013, AP-026, AP-033).
- **Проблема:**
  1. Дельта `turn.boundary` генерируется без поля `providerCheckpointId`, из-за чего BB IDE не может привязать ход к чекпоинту SQLite. Попытка редактирования сообщения (`bb thread edit-message`) или создания форка падает с HTTP 409 (D-11).
  2. Первое событие `snapshot` при подключении `watchEvents` игнорируется, из-за чего при реконнекте состояние незавершенных тулов теряется (D-10).
  3. События `auto_retry_start/end` отбрасываются без уведомления пользователя (D-3).
- **Решение:**
  1. Извлекать хвостовой `EntryId` атомарного коммита SQLite на событии `agent_end` и передавать его как `providerCheckpointId` в дельте `turn.boundary`.
  2. Реализовать восстановление активных слотов генерации и тулов из входящего события `snapshot`.
  3. Транслировать события `auto_retry` в пользовательские сервисные нотификации.
- **Файлы:** `src/runner/bridge/bb-event-adapter.ts`, `src/host/delta-translator.ts`, `tests/checkpoints-and-snapshot.test.ts`.

---

### Cycle 69: Cumulative Token Usage Monotonicity (`pi.usage` Document Sync, D-7)
- **Целевые расхождения:** D-7 (AP-013, AP-026).
- **Проблема:**
  1. `delta-translator.ts` копирует локальный расход последнего хода `last` в кумулятивный итог `total`, сбрасывая суммарный счетчик токенов каждый ход.
- **Решение:**
  1. Считывать кумулятивный расход сессии напрямую из документа `pi.usage` в состоянии хранилища Durable.
  2. Передавать монотонно возрастающие значения `totalTokens`, `cachedInputTokens`, `outputTokens` в дельте `usage`.
- **Файлы:** `src/runner/bridge/bb-event-adapter.ts`, `src/host/message-delta-translator.ts`, `tests/cumulative-usage.test.ts`.

---

### Cycle 70: Checkpoint Thread Forking, Session Rewind & Message Editing (`thread/fork`)
- **Возможности платформы:** `thread/fork`, `bb thread edit-message`, CoW-ветвление SQLite.
- **Решение:**
  1. Добавить команду IPC `fork` в раннер, принимающую `{ sourceProviderThreadId, checkpointId, targetThreadId, cwd }`.
  2. Вызывать `conversation.fork(checkpointEntryId)` ядра `@earendil-works/pi-durable`, сохраняя состояние документов на момент чекпоинта и создавая новый файл `session.sqlite` для дочернего треда.
  3. В `src/host/bridge-router.ts` обработать вызов `thread/fork` и привязать форкнутую сессию к новому идентификатору треда.
- **Файлы:** `src/runner/fork.ts`, `src/host/bridge-router.ts`, `src/host/session.ts`, `tests/thread-fork.test.ts`.

---

### Cycle 71: Visual Subagent Delegation Cards & Hierarchy (`type: "delegation"`)
- **Возможности платформы:** Визуализация вложенных сессий, сабагентов и делегирования.
- **Решение:**
  1. Обновить адаптер событий сабагента для эмита `item.open` с `type: "delegation"`, `providerItemId: childConversationId`, именем сабагента и целью.
  2. Вкладывать поток мыслей и вызовы тулов сабагента внутрь карточки делегации.
  3. Завершать карточку через `item.close` с итоговым ответом.
- **Файлы:** `src/runner/upstream/subagent.ts`, `src/runner/bridge/delegation-adapter.ts`, `src/host/tool-delta-translator.ts`, `tests/delegation.test.ts`.

---

### Cycle 72: Provider Usage & Granular Spend Ledger (`provider/usage`)
- **Возможности платформы:** Панель расхода токенов и финансов в интерфейсе BB IDE.
- **Решение:**
  1. Добавить IPC команду `get_usage` в раннер для чтения документа `pi.usage`.
  2. Реализовать транслятор в стандартный DTO BB `provider/usage` с разбивкой по моделям и инструментам.
  3. Зарегистрировать обработчик метода `provider/usage` в `bridge-router.ts`.
- **Файлы:** `src/host/usage.ts`, `src/host/bridge-router.ts`, `tests/provider-usage.test.ts`.

---

### Cycle 73: Live Task Graph Synchronization (`harness.taskGraph()`)
- **Возможности платформы:** Отображение графа задач и фоновых процессов в BB IDE.
- **Решение:**
  1. Подписаться на события `harness.taskGraph()` ядра Durable.
  2. Транслировать переходы состояний задач (`pending`, `running`, `done`, `failed`) в элементы ленты `backgroundTask` или шаги плана `planSteps`.
- **Файлы:** `src/runner/bridge/task-graph-adapter.ts`, `src/host/task-delta-translator.ts`, `tests/task-graph.test.ts`.

---

### Cycle 74: Advanced Inbox Queuing & Cancellation (`submission.abort`)
- **Возможности платформы:** Отмена хода на лету, атомарная вставка пользовательских сообщений.
- **Решение:**
  1. Обработать команду `turn/cancel_queued`, вызывая `submission.abort()` в `docs["pi.inbox"]`.
  2. Поддержать команду `write_entry` для внесения записей в SQLite без запуска генерации LLM.
- **Файлы:** `src/host/bridge-router.ts`, `src/runner/session-commands.ts`, `tests/inbox-cancellation.test.ts`.

---

### Cycle 75: Custom Durable Chord Documents (`defineDoc`) & Master Conformance
- **Возможности платформы:** Расширяемость хранилища пользовательскими типами документов и финальная аттестация.
- **Решение:**
  1. Реализовать API регистрации кастомных документов `defineDoc` в рантайме Durable.
  2. Финальный прогон conformance-тестов по всем AP-правилам (AP-010 – AP-071).
  3. Публикация мажорного релиза `v0.3.0` (или `v1.0.0`) в каталог плагинов BB IDE.
