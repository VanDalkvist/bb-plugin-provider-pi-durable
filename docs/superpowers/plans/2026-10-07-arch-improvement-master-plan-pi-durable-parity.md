# Master Architectural Implementation Plan: Remediation & Full Parity of Pi Durable in BB IDE

**Document ID:** `plans/pi-durable-bb-provider-arch-master-plan`  
**Version:** 4.3.0 (Master Unified Roadmap: Full Audit Reconciliation, 4 Territories & Engine Parity)  
**Current Release:** `v0.2.11` (Commit: `88806cd`)  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Upstream Engine:** `@earendil-works/pi-durable` v1.0.4 & `@earendil-works/pi-coding-agent` v1.0.4  
**Host Target:** Beyond Boundaries (BB IDE) `>= 0.45`  
**Status:**
- **Stage 1 (Foundation Hardening, Territory Decoupling & Host Parity):** ✅ 100% COMPLETED (Cycles 56–66, Releases `v0.2.1` – `v0.2.11`)
- **Stage 2 (Advanced Engine Capabilities & Extended Parity):** ⏳ IN PROGRESS / PLANNED (Cycles 67–73)

---

## 1. Architectural Guardrails & The Four Territories Invariant

### 1.1 The Four Territories Architectural Boundary
A foundational invariant of `bb-plugin-provider-pi-durable` is that **it functions strictly as a thin bidirectional GoF Adapter** between BB IDE and the Pi Durable engine, with zero foreign domain ownership:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Territory 1: BB IDE (Host & UI Surface)                                │
│ • Contracts: Plugin SDK, JSON-RPC (turn/start, turn/steer, thread/stop)│
│ • UI widgets: diff viewer, thinking accordion, context window meter    │
│ • Protocol realities:                                                  │
│   - Reasoning rows are collapsed-by-default by design (no auto-expand)  │
│   - Presentation schema: { label, icon, title, detail, suppress, etc } │
│   - Checkpoints: turn.boundary requires providerCheckpointId for edit  │
│   - provider/usage is a subscription quota endpoint (returns !supported│
│     for standard LLM providers; in-thread usage delta handles tokens)   │
│   - Delegations: deltaDelegationShapeSchema { type: "delegation" }      │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ (JSON-RPC stdio)
┌──────────────────────────────────▼─────────────────────────────────────┐
│ Territory 4: The Provider Plugin (bb-plugin-provider-pi-durable)       │
│ • SOLE LEGITIMATE ROLE: Pure Bidirectional Adapter (GoF Adapter)       │
│ • Translates BB JSON-RPC requests ──► Pi Durable Harness commands      │
│ • Translates FSM AgentEvent/docs ──► BB WireEvents & chat deltas       │
│ • DOES NOT OWN: prompt texts, agent rules, custom UI widgets, or       │
│   recursive subagent orchestration frameworks                          │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │                                 │
                   │ (Durable API)                   │ (Settings & Ext)
┌──────────────────▼───────────────┐ ┌───────────────▼───────────────────┐
│ Territory 2: Pi Durable Core    │ │ Territory 3: Pi Ecosystem / CLI   │
│ (@earendil-works/pi-durable)     │ │ (@earendil-works/pi-coding-agent) │
│ • FSM tasks (Generation, Tool)   │ │ • SettingsManager, MCP discovery  │
│ • ACID SQLite WAL persistence    │ │ • ModelRuntime, provider catalogs │
│ • CoW forks (conversation.fork)  │ │ • Tool definitions, skills, rules │
│ • Documents (pi.agent, pi.usage) │ │ • Dynamic extensions (mcp/code)   │
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
| **D-5** | **Маскирование сбоев тулов** | `event.entry` отсутствует (`undefined`), если задача тула упала | ⏳ **PLANNED** (`isError: true` при отсутствии `entry` в `tool_execution_end`) | Stage 2 (Cycle 67) |
| **D-6** | **Потеря метаданных Diff** | `CodingTools.edit` возвращает `details: { diff, patch }` | ⏳ **PLANNED** (Проброс патчей в BB Diff Viewer) | Stage 2 (Cycle 67) |
| **D-7** | **Фальсификация кумулятивного расхода** | `pi.usage` накапливает кумулятивный расход сессии | ⏳ **PLANNED** (Монотонный подсчет totalTokens из документа usage) | Stage 2 (Cycle 70) |
| **D-8** | **Краш моделей без reasoning** | `setThinkingLevel` выбрасывает ошибку при `!model.reasoning` | ✅ **FIXED** (Безопасный фоллбек и фильтрация thinkingLevel) | `v0.2.8` (Cycle 63), `v0.2.10` (Cycle 65) |
| **D-9** | **Обрезка вывода тулов и диагностики** | `tool_execution_update` передает `trimStart` и `diagnostics` | ⏳ **PLANNED** (Проброс `trimStart` и диагностических предупреждений) | Stage 2 (Cycle 67) |
| **D-10**| **Обработка `snapshot` при старте** | При старте `watchEvents` первым приходит снимок состояния | ⏳ **PLANNED** (Восстановление активных слотов из `snapshot`) | Stage 2 (Cycle 68) |
| **D-11**| **Чекпоинты в `turn.boundary`** | Каждый ход завершается атомарным `EntryId` для rewind/fork | ⏳ **PLANNED** (Передача `providerCheckpointId` в `turn.boundary`) | Stage 2 (Cycle 68) |
| **D-12**| **Отображение цепочки мыслей** | Потоковая передача `thinking_delta`, аккордеон с Brain-иконкой | ✅ **FIXED** (Brain icon, streaming `reasoningText`, lifecycle closure) | `v0.2.8`–`v0.2.11` (Cycles 63–66) |
| **D-13**| **Молчаливые системные сбои** | При краше раннера или ошибке CWD эмитится `provider.error` | ✅ **FIXED** (`child.on("error")`, fail-fast start, `settlesTurn: true`) | `v0.2.1` (Cycle 56) |
| **D-14**| **Синхронизация Context Meter** | Точный учет контекстного окна модели в реальном времени | ✅ **FIXED** (Синхронный эмит `contextWindow` на `agent_end`) | `v0.2.2` (Cycle 57), `v0.2.4` (Cycle 59) |
| **D-15**| **Невидимость тулов `edit`/`write` и зависание steer** | `write` -> `add`, `edit` -> `update`; steer без `providerTurnId` | ✅ **FIXED** (Zod-валидные дельты, исключение 409-конфликта) | `v0.2.3` (Cycle 58) |

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

STAGE 2: РАСШИРЕННЫЕ ВОЗМОЖНОСТИ ДВИЖКА И ПОЛНЫЙ ПАРИТЕТ С ПЛАТФОРМОЙ (Cycles 67–73) [⏳ В РАБОТЕ]
  - Cycle 67: Отказоустойчивость тулов, diff-метаданные и диагностики вывода (D-5, D-6, D-9)
  - Cycle 68: Извлечение чекпоинтов SQLite, обработка snapshot и turn.boundary (D-3, D-10, D-11)
  - Cycle 69: Чекпоинт-форки тредов, перемотка истории и редактирование сообщений (thread/fork, bb thread edit-message)
  - Cycle 70: Монотонный учет кумулятивного расхода токенов через pi.usage (D-7)
  - Cycle 71: Визуальные карточки сабагентов через протокольный deltaDelegationShape (type: "delegation")
  - Cycle 72: Корректное прерывание хода, inbox-отмена и обработка thread/stop (submission.abort)
  - Cycle 73: Мастер-аттестация паритета с нативным provider-pi и conformance-тесты
```

---

## 4. Спецификации завершённых циклов (Stage 1: Cycles 56–66)

*(Зафиксировано в истории релизов v0.2.1 – v0.2.11; 63 теста проходят успешно, все изменения запушены в GitHub).*

---

## 5. Детальные спецификации предстоящих циклов (Stage 2: Cycles 67–73)

---

### Cycle 67: Tool Fault Integrity, Output Diagnostics & Diff Metadata (D-5, D-6, D-9)
- **Целевые расхождения:** D-5, D-6, D-9 (AP-012, AP-013, AP-026).
- **Архитектурный анализ первоисточников:**
  1. В спецификации `@earendil-works/pi-durable` (`docs/spec.md:4129`):
     `/** entry is absent when the tool task faulted or was orphaned. */ | { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: EntryRecord }`
     В текущем `bb-event-adapter.ts`: если `event.entry` отсутствует, `extractToolResult(undefined)` возвращает `{ result: "", isError: false }`. Это грубо маскирует аварии тулов и нарушает AP-012/AP-013!
  2. Фабрика `CodingTools.edit` из `@earendil-works/pi-coding-agent` возвращает `details: { diff, patch, firstChangedLine }`.
  3. `tool_execution_update` в Durable ядре эмитит `output: { trimStart, append }` и `diagnostics`.
- **Решение:**
  1. В `bb-event-adapter.ts` при `event.entry === undefined` в `tool_execution_end` принудительно устанавливать `isError: true` с диагностикой `"Tool execution faulted or was orphaned"`.
  2. Пробрасывать `event.details` через `BBWireEvent` в `tool-delta-translator.ts` для обогащения `fileChange` диффом.
  3. Транслировать `trimStart` и диагностические сообщения тула в поток событий.
- **Файлы:** `src/runner/bridge/bb-event-adapter.ts`, `src/host/tool-delta-translator.ts`, `tests/tool-fault-and-diff.test.ts`.

---

### Cycle 68: Checkpoint Extraction, Native Event Stream & `turn.boundary` Parity (D-3, D-10, D-11)
- **Целевые расхождения:** D-3, D-10, D-11 (AP-013, AP-026, AP-033).
- **Архитектурный анализ первоисточников:**
  1. В `start-server.js` BB IDE: при вызове `bb thread edit-message` сервер выполняет `resolveTurnProviderCheckpointId`. Если `precedingCompletion.providerCheckpointId === null`, BB выбрасывает конфликт: `"This earlier provider turn has no editable history checkpoint"`.
  2. В нативном `provider-pi`: на событии `agent_end` хост запрашивает хвостовой идентификатор коммита сессии (`channelRequest({ method: "leaf" })` или `agent-end-leaf`) и передает его в `turn.boundary`: `{ providerCheckpointId: leafId }`.
  3. `watchEvents` ядра Durable при подключении выдает первым событием `snapshot`, отражающий текущее состояние слотов задач.
- **Решение:**
  1. Извлекать хвостовой `EntryId` атомарного коммита SQLite на событии `agent_end` и передавать его как `providerCheckpointId` в wire-событии `turn_end` / `agent_end` и хостовой дельте `turn.boundary`.
  2. Обрабатывать входящее событие `snapshot` для восстановления активных слотов при реконнекте к работающей сессии.
  3. Транслировать события `auto_retry_start/end` в сервисные уведомления пользователя.
- **Файлы:** `src/runner/bridge/bb-event-adapter.ts`, `src/host/delta-translator.ts`, `src/host/message-delta-translator.ts`, `tests/checkpoints-and-snapshot.test.ts`.

---

### Cycle 69: Checkpoint Thread Forking, Session Rewind & Message Editing (`thread/fork`)
- **Возможности платформы:** `thread/fork`, `bb thread edit-message`, CoW-ветвление SQLite сессий.
- **Архитектурный анализ первоисточников:**
  1. В `start-server.js`: редактирование сообщений на хостах с `capabilities.fork === "checkpoint"` вызывает `thread.rewind.prepare` с `retainThroughProviderCheckpoint` и `sourceProviderThreadId`.
  2. В нативном `provider-pi`: метод `thread/fork` вызывает `forkSessionFile({ sourceFile, targetFile, cwd, checkpointId })`.
  3. В ядре `@earendil-works/pi-durable`: метод `conversation.fork(checkpointEntryId)` выполняет ACID CoW-ветвление сессии на указанном коммите.
- **Решение:**
  1. Добавить команду IPC `fork` в раннер, принимающую `{ sourceProviderThreadId, checkpointId, targetThreadId, cwd }`.
  2. Вызывать `conversation.fork(checkpointEntryId)` ядра `@earendil-works/pi-durable`, сохраняя состояние документов на момент чекпоинта и создавая новый файл `session.sqlite` для дочернего треда.
  3. В `src/host/bridge-router.ts` и `bridge.ts` реализовать честную обработку RPC вызова `thread/fork` (сейчас там заглушка с пустым тредом).
- **Файлы:** `src/runner/fork.ts`, `src/host/bridge-router.ts`, `src/host/bridge.ts`, `src/host/session.ts`, `tests/thread-fork.test.ts`.

---

### Cycle 70: Cumulative Token Usage Monotonicity (`pi.usage` Document Sync, D-7)
- **Целевые расхождения:** D-7 (AP-013, AP-026).
- **Архитектурный анализ первоисточников:**
  1. В протоколе BB IDE: метод `provider/usage` предназначен исключительно для учетных окон подписок (например, ChatGPT rate-limits в Codex). Нативный `provider-pi` отвечает на `provider/usage`: `{ supported: false }`.
  2. Учет токенов модели в BB ведется внутри треда через дельту `usage` (`{ totalTokens, inputTokens, outputTokens }`).
  3. В ядре `@earendil-works/pi-durable`: документ `docs["pi.usage"]` и метод `harness.usage(context)` ведут строгий монотонный накопительный итог токенов по моделям и тулам (`totals only grow`).
  4. Сейчас в `delta-translator.ts`: расход последнего хода `last` дублируется в `total`, сбрасывая историю при каждом новом ходе.
- **Решение:**
  1. Считывать кумулятивный расход сессии напрямую из документа `pi.usage` в состоянии хранилища Durable.
  2. Передавать истинные монотонно возрастающие значения `totalTokens`, `cachedInputTokens`, `outputTokens` в дельте `usage`.
  3. Гарантировать, что `provider/usage` возвращает `{ supported: false }` согласно спецификации BB.
- **Файлы:** `src/runner/bridge/bb-event-adapter.ts`, `src/host/message-delta-translator.ts`, `src/host/bridge-router.ts`, `tests/cumulative-usage.test.ts`.

---

### Cycle 71: Visual Subagent Delegation Cards via Protocol Schema (`type: "delegation"`)
- **Возможности платформы:** Визуализация сабагентов через протокол BB `@bb/provider-bridge-protocol`.
- **Архитектурный анализ первоисточников:**
  1. Протокол моста BB содержит каноническую схему `deltaDelegationShapeSchema`:
     `{ type: "delegation", childRef: string, label: string, background: boolean, summary?: string }`.
  2. Плагин провайдера **НЕ должен** строить собственную платформу оркестрации агентов (это нарушает границы Территории 4). Его задача — чисто транслировать выполнение инструмента `subagent` в протокольную карточку делегирования.
- **Решение:**
  1. При запуске под-сессии тула `subagent` эмитить `item.open` с формой `delegation` (`label`, `childRef: childConversationId`).
  2. Вкладывать логи и мысли дочернего агента внутрь элемента делегации.
  3. Закрывать элемент через `item.close` с итоговым резюме.
- **Файлы:** `src/runner/upstream/subagent.ts`, `src/runner/bridge/delegation-adapter.ts`, `src/host/tool-delta-translator.ts`, `tests/delegation.test.ts`.

---

### Cycle 72: Clean Turn Interruption, Inbox Abort & Cancellation (`submission.abort`)
- **Возможности платформы:** Гарантированное прерывание хода по кнопке Stop / `thread/stop`.
- **Архитектурный анализ первоисточников:**
  1. При нажатии пользователем Stop в UI BB IDE хост присылает `thread/stop` с `intent: "interrupt"`.
  2. В ядре `@earendil-works/pi-durable`: активные задачи и входная очередь отменяются через `submission.abort(context)`.
- **Решение:**
  1. Обработать команду `thread/stop` (`intent: "interrupt"`), вызывая `submission.abort()` в `docs["pi.inbox"]`.
  2. Гарантировать эмит дельты `turn.boundary` со статусом `interrupted` и немедленный возврат управления.
- **Файлы:** `src/host/bridge-router.ts`, `src/runner/session-commands.ts`, `tests/interruption-and-cancellation.test.ts`.

---

### Cycle 73: Master Parity Conformance Audit & End-to-End Verification
- **Цель:** Итоговая валидация 100% паритета с нативным `provider-pi`, аттестация по правилам AP-010 – AP-071.
- **Решение:**
  1. Прогон всех сквозных сценариев (многоходовые сессии, редактирование сообщений через `bb thread edit-message`, форки тредов, аварии тулов, переключение моделей, reasoning streaming).
  2. Проверка соответствия лимитам строк (AP-019), строгой типизации (AP-029), отсутствию гонок lockfile (AP-033).
  3. Фиксация стабильного релизного тега.
- **Файлы:** Полный сьют тестов `tests/*.test.ts`, `docs/arch-improvement/ledger.md`.
