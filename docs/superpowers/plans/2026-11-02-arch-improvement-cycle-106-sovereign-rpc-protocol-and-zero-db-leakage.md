# Arch Improvement Cycle 106: Sovereign Wire Protocol & Zero DB Leakage

- **Цель:** Превратить `durable-zero` в 100% суверенный headless-рантайм с каноническим двусторонним RPC-протоколом по `stdio` (полная ликвидация хака с дескрипторами FD 3/4) и полностью устранить утечки SQLite сессий агента из хоста Beyond Boundaries (`bb-plugin-provider-pi-durable`).
- **Связанный аудит:** `docs/arch-improvement/audits/2026-11-02-sovereign-rpc-and-db-leakage-audit.md`
- **Архитектурные правила (AP Gates):**
  - AP-001 (Sovereign Core Purity): Ядро не содержит специфики внешних сред и дескрипторов 3/4.
  - AP-002 (Single Source of Truth): Форк и структура сессий инкапсулированы в `durable-zero`.
  - AP-003 (Protocol Completeness): Wire-протокол выражает полный спектр управления жизненным циклом и возможностями хоста.
  - AP-010 (Hexagonal Architecture / Ports & Adapters): Четкое разделение домена, портов и адаптеров.
  - AP-012 (Coupling to External Harness): Нулевая завязка на приватные соглашения Beyond Boundaries.
  - AP-019 (Line Budgets): Каждый файл строго < 250 LOC.

---

## Architecture Context Map

- **Stage:** scale / hardening
- **Source docs:**
  - `docs/arch-improvement/audits/2026-11-02-sovereign-rpc-and-db-leakage-audit.md`
  - `packages/contracts/src/runner-command.ts`, `packages/contracts/src/runner-event.ts`
  - `src/host/runner-process.ts`, `src/host/thread-fork.ts`, `src/host/session.ts`
- **Active paths:**
  - `durable-zero/packages/contracts/`
  - `durable-zero/packages/core/`
  - `bb-plugin-provider-pi-durable/src/host/`
- **Critical gates:** AP-001, AP-002, AP-003, AP-010, AP-012, AP-019
- **Baseline gates:** AP-013, AP-014, AP-015, AP-022, AP-023
- **Known deviations:**
  - `runner-lookup.ts` и `subthread-spawner.ts` читают глобальную базу BB (`bb.db`) для метаданных тредов IDE — это законная интеграция с BB IDE. Но чтение `session.sqlite` сессий агента в `thread-fork.ts` — недопустимая утечка домена.
- **Verification surface:**
  - `pnpm --filter @durable-zero/contracts test`
  - `pnpm --filter @durable-zero/core test`
  - `pnpm --filter @durable-zero/cli test`
  - `npm run test` в `bb-plugin-provider-pi-durable` (446 тестов)
  - `npm run doctor` в `bb-plugin-provider-pi-durable`
  - `node scripts/verify-layer-boundaries.mjs`
- **Open decisions:**
  - `session_fork`: реализуется как RPC-команда для работающего раннера или как экспортируемая сервисная функция ядра `forkSessionDatabase` из `@durable-zero/core` для холодных сессий? Ответ: **Оба варианта**. Хост BB форкает холодные сессии ДО старта дочернего раннера (через экспортируемую функцию ядра `@durable-zero/core/session-storage`), а раннер поддерживает `session_fork` через RPC для динамических форков. В обоих случаях хост BB больше не содержит SQL-запросов к `session.sqlite`.

---

## Triage: Решения по дефектам

- `fix-now`:
  - **D-106-01 (P1):** Прямой доступ хоста к `session.sqlite` в `thread-fork.ts` (перенос логики в `@durable-zero/core`).
  - **D-106-02 (P1):** Ликвидация FD 3/4 дескрипторов в `bridge-channel.ts` и `runner-server.ts`.
  - **D-106-03 (P2):** Полнота Wire-протокола (`host_tool_call`, `host_tool_result`, `host_interaction_request`, `host_interaction_response`, `session_fork`).
  - **D-106-04 (P2):** Перевод `RunnerProcess` в BB хосте на чистый POSIX `stdio: ["pipe", "pipe", "pipe"]`.
- `log-only`:
  - Подключение альтернативных транспортов (Unix Domain Sockets / WebSockets) для удаленных клиентов (выносится в отдельный пакет `@durable-zero/server`).
- `blocked`:
  - Нет.

---

## План пошаговой реализации (Slices)

### Slice 1: Полнота Wire-протокола (@durable-zero/contracts)
- **Boundary:** DTO / Wire Protocol (`@durable-zero/contracts`)
- **AP gates:** AP-003, AP-010, AP-019
- **Red test first:**
  - Добавить тест в `packages/contracts/test/wire-host-channels.test.ts`, проверяющий:
    1. Валидацию `runnerCommandSchema` для `session_fork`: `{ type: "session_fork", sourceDir: "...", targetDir: "...", checkpointId: 10 }`.
    2. Валидацию `runnerCommandSchema` для `host_tool_result`: `{ type: "host_tool_result", callId: "c1", result: [...], isError: false }`.
    3. Валидацию `runnerCommandSchema` для `host_interaction_response`: `{ type: "host_interaction_response", id: "i1", result: "ok" }`.
    4. Валидацию `runnerEventSchema` для `host_tool_call`: `{ type: "host_tool_call", callId: "c1", toolName: "read", arguments: {} }`.
    5. Валидацию `runnerEventSchema` для `host_interaction_request`: `{ type: "host_interaction_request", id: "i1", dialogKind: "confirm", title: "T", message: "M" }`.
- **Expected failure:** Схемы реджектят новые типы сообщений (`Invalid enum value`).
- **Implementation:**
  - В `runner-command.ts` расширить `runnerCommandSchema` новыми командами.
  - В `runner-event.ts` (или `wire-tool.ts` / `wire-lifecycle.ts`) добавить новые события хоста.
- **Passing test:**
  - `pnpm --filter @durable-zero/contracts test` проходит 100% green.
- **Verification:** `pnpm test` во всем монорепозитории `durable-zero`.

---

### Slice 2: Суверенная инкапсуляция сессий и SQLite в ядре (@durable-zero/core)
- **Boundary:** Domain / Infrastructure Storage (`@durable-zero/core/session-storage.ts`)
- **AP gates:** AP-001, AP-002, AP-010, AP-019
- **Red test first:**
  - Написать тест `packages/core/test/session-fork.test.ts`:
    - Инициализирует тестовую сессию с `entries` и `tasks`.
    - Вызывает `forkSessionDatabase({ sourceDir, targetDir, checkpointId: 5 })`.
    - Проверяет, что база создана, VACUUM выполнен, и все `entries.id > 5` и `tasks.id > 5` удалены.
    - Проверяет снятие блокировок в `targetDir`.
- **Expected failure:** Функция `forkSessionDatabase` не экспортируется из `@durable-zero/core`.
- **Implementation:**
  - Реализовать `forkSessionDatabase` в `packages/core/src/session-storage.ts` (или `packages/core/src/session-fork.ts`).
  - Экспортировать `forkSessionDatabase` из публичного API `packages/core/src/index.ts`.
  - Добавить обработку команды `session_fork` в `session-commands.ts` и `runner-server.ts`.
- **Passing test:**
  - `pnpm --filter @durable-zero/core test` проходит 100% green.
- **Verification:** Прогон `session-fork.test.ts`.

---

### Slice 3: Двусторонний RPC по stdio и ликвидация FD 3/4 (@durable-zero/core)
- **Boundary:** Interface Entrypoint / Transport (`packages/core/src/runner-server.ts`)
- **AP gates:** AP-001, AP-010, AP-012, AP-019
- **Red test first:**
  - Написать интеграционный тест `packages/core/test/stdio-host-tool-call.test.ts`:
    - Создает сессию с mock-тулом хоста.
    - Агент вызывает тул хоста.
    - Проверяет, что в `stdout` раннера прилетает `{"type": "host_tool_call", "callId": "c1", ...}`.
    - Пишет в `stdin` раннера `{"type": "host_tool_result", "callId": "c1", "result": [{ "type": "text", "text": "hello" }]}`.
    - Проверяет, что тул успешно резолвится без использования дескрипторов 3/4.
- **Expected failure:** Раннер пытается писать в FD 3 и падает с `EBADF`.
- **Implementation:**
  - Заменить логику `bridge-channel.ts`:
    - `forwardToolCall` пишет в `stdout` событие `host_tool_call` и регистрирует ожидание в `pendingToolCalls`.
    - `requestInteraction` пишет в `stdout` событие `host_interaction_request` и регистрирует ожидание в `pendingInteractions`.
    - Обработчик `stdin` в `runner-server.ts` ловит `host_tool_result` и `host_interaction_response` и резолвит промисы.
  - Удалить `packages/core/src/bridge-channel.ts`.
  - Пересобрать `build-runner.mjs`.
- **Passing test:**
  - `pnpm test` в `durable-zero` проходит 100% green.
- **Verification:** Все тесты раннера и CLI проходят.

---

### Slice 4: Адаптер хоста Beyond Boundaries на чистом stdio и без SQLite (bb-plugin-provider-pi-durable)
- **Boundary:** Host Adapter (`src/host/`)
- **AP gates:** AP-001, AP-002, AP-010, AP-012, AP-019
- **Red test first:**
  - Написать/обновить тест `tests/posix-stdio-transport.test.ts` и `tests/contracts-bb-tools.test.ts`:
    - Проверить, что процесс раннера запускается строго с `stdio: ["pipe", "pipe", "pipe"]` (3 пайпа, а не 5).
    - Проверить, что `thread-fork.ts` использует `forkSessionDatabase` из `@durable-zero/core` без импорта `node:sqlite`.
- **Expected failure:** Тест падает на ожидании FD 3/4 или наличии прямого импорта `DatabaseSync` в `thread-fork.ts`.
- **Implementation:**
  - В `src/host/thread-fork.ts`:
    - Удалить `import { DatabaseSync } from "node:sqlite"`.
    - Вызывать `forkSessionDatabase` из `@durable-zero/core`.
  - В `src/host/runner-process.ts`:
    - Изменить `stdio: ["pipe", "pipe", "pipe"]`.
    - Удалить чтение FD 3 и запись в FD 4 (`channelIn`, `channelOut`, `sendChannel`).
  - В `src/host/session.ts` и `src/host/runner-rpc-channel.ts`:
    - Обрабатывать входящие события `host_tool_call` и `host_interaction_request` из `stdout`.
    - Отвечать командами `host_tool_result` и `host_interaction_response` в `stdin`.
- **Passing test:**
  - `npm run test` в `bb-plugin-provider-pi-durable` проходит (446 / 446 green).
- **Verification:**
  - `npm run test:contracts`
  - `npm run doctor`

---

### Slice 5: Двухконтурная верификация, аудит бюджетов и Ledger
- **Boundary:** Verification & Audit
- **AP gates:** AP-019, AP-020, AP-022, AP-023
- **Verification Commands:**
  - `durable-zero`: `pnpm test` (все пакеты).
  - `bb-plugin-provider-pi-durable`: `npm test`, `npm run doctor`, `node scripts/verify-layer-boundaries.mjs`.
  - Проверка бюджетов LOC: `find src/ -name "*.ts" -exec wc -l {} + | sort -n` (< 250 LOC на файл).
- **Artifacts:**
  - Запись в `docs/arch-improvement/ledger.md` (Cycle 106).
  - Запись в `docs/arch-improvement/memory.md`.
