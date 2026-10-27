
### Non-Blocking Background Subagents & Turn Watchdog Prevention (Cycle 79) — 2026-10-27 (Execution Receipt)
- **Цель и статус:** Устранение блокировки родительской беседы при работе фоновых субагентов (P1-SUB1) и предотвращение ложного срабатывания сторожевого таймера 120s в BB Core (P1-WD1). Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и первоисточники:**
  1. *[P1-SUB1: Разблокировка родителя через канонический Anchor]:*
     - Первоисточник: спецификация Pi Durable §5.5 (Rule 4) и канонический пример `packages/durable/test/examples/23-subagent-background.ts`.
     - Коренная причина: `src/runner/subagent.ts` создавал дочернюю беседу с `ownership: { kind: "task", taskId: api.taskId }`, назначая владельцем синхронный вызов инструмента `pi.tool`. Из-за этого планировщик Pi Durable удерживал инструмент в статусе `completing` на всё время работы субагента, а родительская генерация стояла в `waiting`, блокируя родительскую беседу.
     - Решение: при `isBackground: true` дочерняя беседа создаётся под фоновым анкером `tx.createTask(Anchor, null, BACKGROUND)`. Инструмент `api.taskId` завершается за 50 мс (`terminal`), родительская беседа становится `idle`, может сразу отвечать пользователю и запускать параллельных субагентов.
  2. *[P1-WD1: Снятие сторожевого таймера 120s в BB Core]:*
     - Первоисточник: исходники BB Core (`daemon-bundle.mjs`, таймер `turnStartWatchdog = 120s`, множество `p`).
     - Коренная причина: `handleTurnStart` в `src/host/bridge-router.ts` на корневом треде отправлял только `input.accepted`, но не отправлял `turn.open`, ожидая `turn_start` от раннера.
     - Решение: отправка `{ kind: "turn.open" }` сразу при приёме ввода в `handleTurnStart` (по образцу `provider-claude-code` и собственной реализации для child threads). Это сразу очищает `p` в BB Core и снимает таймер.
  3. *[P2-UI1: Логическая иерархия дерева задач UI]:*
     - В `RuntimeGraphConversations` добавлен метод `recordLogicalOwner`.
     - `RuntimeGraphSource` извлекает `ownerTaskId` из `SubagentsDoc` и связывает дочернюю беседу с вызывающим инструментом `subagent: ...`, сохраняя аккуратную иерархию в UI Task Tree.
- **TDD и доказательная база:**
  - `tests/turn-start-watchdog-prevention.test.ts`: 46 строк (< 200). RED: подтверждён провал без `turn.open`; GREEN: подтверждена немедленная отправка `turn.open` на корневом треде.
  - `tests/subagent-background-unblock.test.ts`: 113 строк (< 200). RED: подтверждено отсутствие `Anchor`; GREEN: подтверждено создание под `Anchor` (`background: true`) и сохранение прямого владения для foreground-режима.
  - Общий сьют: **530 тестов бэкенда: 530 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (Negative contract guard: TS2322 rejection, pass).
  - Типизация: `npx tsc --noEmit` (0 errors).
- **Line Budgets (AP-019):**
  - `src/runner/subagent.ts`: 184 строки (< 200)
  - `src/host/bridge-router.ts`: 186 строк (< 200)
  - `src/runner/runtime-graph-conversations.ts`: 52 строки (< 200)
  - `src/runner/runtime-graph-source.ts`: 197 строк (< 200)
  - `tests/turn-start-watchdog-prevention.test.ts`: 46 строк (< 200)
  - `tests/subagent-background-unblock.test.ts`: 113 строк (< 200)
- **Сборка (Build Receipt):**
  - Бандлы пересобраны: `npm run build` успешно собрал `dist/runner/index.js`, `dist/host.js`, `dist/server.js`.
  - Версия обновлена до **0.3.2**.

### Truthful Live Graph Metadata & Sanitized Attributes (Cycle 80) — 2026-10-27 (Execution Receipt)
- **Цель и статус:** Устранение 4 подтверждённых первопричин исчезновения и обезличивания активных/быстрых задач в Runtime Task Graph (`runtime-graph-live-truth-investigation.md`). Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и архитектурные решения:**
  1. *[Сохранение имён быстрых инструментов в terminal receipts]:*
     - При завершении задач до истечения 250 мс дебаунса `subscribeCommits` в `RuntimeGraphSource` вызывает `recordTerminalWithDetails(receipts, taskVal, names, nativeStartedAt)`.
     - `TaskNames` хранит структурированные `TaskCallDetails` (`toolName`, `targetHint`, `preview`).
     - В `RuntimeTaskReceipt` заносятся реальные `toolName`, `targetHint`, `preview`, `startedAt`, `durationMs` вместо анонимного fallback `pi.tool #id`.
  2. *[Безопасная санитизация targetHint]:*
     - Функция `sanitizeTargetHint` в `task-labels.ts` фильтрует только разрешённые строковые ключи (`command`, `path`, `pattern`, `query` и др.) и выполняет детерминированную санитизацию: удаляет Bearer токены, `ghp_` токены, API ключи, пароли и секреты, предотвращая утечку sensitive data в снимки графа. Длина строго ограничена <= 128 символов.
  3. *[Передача реальных метаданных generation]:*
     - В `runtime-graph-mapper.ts` реализована функция `extractTaskModelMeta`, извлекающая точную модель (`model: { provider, modelId }`) и `thinkingLevel` из чекпоинта `GenerationTask` (фаза `request`) либо из `pi.agent` doc (для root) / `bb.subagents` doc (для child). Исключены любые глобальные дефолты или догадки.
     - Для задачи генерации формируется информативная подпись: `assistant turn · ${modelId} (${thinkingLevel})`.
  4. *[Настоящее время старта и длительность]:*
     - Точное время `TaskRecord.startedAt` фиксируется в `nativeStartedAt` на момент коммита задачи. Проспективное время наблюдения НЕ называется `startedAt`. Для активных задач вычисляется `durationMs = clock() - startedAt`.
  5. *[Связывание логического владения субагентами]:*
     - `recordSubagentOwnership` считывает `ownerTaskId` из `bb.subagents` и связывает дочерние беседы с вызвавшим инструментом родителя в `RuntimeGraphConversations.recordLogicalOwner`.
- **TDD и доказательная база:**
  - `tests/runtime-graph-live-metadata.test.ts`: 159 строк (< 200 LOC), 8 тестов, 100% pass:
    * Приёмка санитизированных полей `toolName`, `targetHint`, `model`, `thinkingLevel`, `startedAt` Zod-схемами.
    * Отклонение оверлоад-полей (>64/128/32 символов).
    * Санитизация Bearer, ghp и api_key токенов.
    * Обучение `TaskNames` структурированным именам из `pi.live` и transcript.
    * Сохранение имени и превью при завершении задачи за 5 мс до дебаунса.
    * Извлечение реальной модели и thinkingLevel для узла генерации.
    * Логическое связывание бесед субагента по `ownerTaskId`.
  - Все 63 теста runtime graph: **63 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (Negative contract guard: TS2322 rejection pass).
  - Строгая типизация: `npx tsc --noEmit` (0 errors).
- **Line Budgets (AP-019):**
  - `src/runtime-graph/types.ts`: 138 строк (< 200)
  - `src/runtime-graph/schema.ts`: 169 строк (< 200)
  - `src/runner/task-labels.ts`: 106 строк (< 200)
  - `src/runner/runtime-graph-mapper.ts`: 186 строк (< 200)
  - `src/runner/runtime-graph-receipts.ts`: 154 строки (< 200)
  - `src/runner/runtime-graph-conversations.ts`: 52 строки (< 200)
  - `src/runner/runtime-graph-source.ts`: 180 строк (< 200)
  - `tests/runtime-graph-live-metadata.test.ts`: 159 строк (< 200)
- **Файловый артефакт:** `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/runtime-graph-live-metadata-fix-result.md`.

### Candidate Checkpoint 0.3.4 (Cycle 79 Integration & Dist Reconciliation) — 2026-10-27 (Execution Receipt)
- **Цель и статус:** Интеграция и фиксация незакоммиченного кандидата Cycle 79 (канонический паттерн фоновых субагентов `Anchor` по Pi Durable Spec §5.5 Rule 4, снятие сторожевого таймера 120s `turn.open` в `handleTurnStart`), синхронизация `dist/` бандлов, микробэмп `0.3.3` -> `0.3.4`. Статус: **CHECKPOINT COMMITTED & PUSHED (Architecture and Live Review gates remain OPEN; NOT final PASS)**.
- **Основание и прямое разрешение:** Прямое поручение Вани («Если есть незакоммиченные версии файлов – делай новый микро бамп, коммить и пушь»). Снятие гейта публичного репозитория для сохранения целостного рабочего снимка. Handoff ownership подтверждён автором `thr_t3x53wmjif`.
- **Реальные выполненные изменения:**
  1. `src/runner/subagent.ts`: канонический `Anchor` task (`{ ownership: { kind: "conversation" }, background: true }`) для фоновых субагентов, освобождающий инструмент `api.taskId` в `terminal` и возвращающий родительскую беседу в `idle`.
  2. `src/runner/subagent-docs.ts`: фиксация `anchorTaskId` в `SubagentRecord`.
  3. `src/host/bridge-router.ts`: отправка `{ kind: "turn.open" }` сразу при приёме ввода в `handleTurnStart` на корневом треде для разоружения 120s watchdog таймера в BB Core.
  4. `tests/subagent-background-unblock.test.ts` & `tests/turn-start-watchdog-prevention.test.ts`: TDD тесты на паттерн Anchor и watchdog-предотвращение.
  5. `package.json`, `package-lock.json`, `CHANGELOG.md`: версия обновлена `0.3.3` -> `0.3.4`.
  6. Пересобраны production-бандлы `dist/` из точного исходного кода.
- **TDD и доказательная база:**
  - Полный тестовый сьют (`npm test`): 582 теста (539 backend + 43 UI), 100% pass, 0 fail.
  - Contract compiler & negative guard (`npm run test:contracts`): PASS.
  - Строгая типизация (`npx tsc --noEmit`): 0 errors.
  - Import AST SCC (алгоритм Тарьяна): 135 файлов, 0 циклов.
  - Line budgets (AP-019): все файлы строго < 200 LOC.
- **Статус ревью, рантайма и открытых дефектов:**
  - Архитектурное и независимое live review (thr_qf7vysbvrr): **OPEN**.
  - Realtime stale graph bug & UI active-first / "See more" compact history / native BB chrome: **OPEN** (подтверждённый user report, evidence собирается независимыми reviewers; не входит в 0.3.4 freeze, получит отдельный ownership и следующий patch).
  - Runtime resident state: плагин на диске обновлён до 0.3.4, но работающие сессии BB удерживают загруженный процесс (`restart: pending`, `runtime verified: unverified (not switched)`).
