# Отчёт интеграционной верификации кандидата bb-plugin-provider-pi-durable

**Дата:** 2026-10-26  
**Рабочее дерево:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Исполнитель:** Нативный subagent (интеграционный верификатор)  
**Режим:** Read-only верификация (source frozen; без правок кода, без коммитов, без push, без bump)  
**Входные результаты устранения findings:**
- `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/admission-review-fixes-result.md` (Admission slice, 3 findings)
- `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/runtime-graph-review-fixes-result.md` (Runtime graph slice, 5 findings)

---

## Итоговый вердикт

# **VERDICT: FAIL**

**Причины отклонения шлюза (Gate Failure):**
1. **[P1 Регрессия тестов] `npm test` завершился с кодом 1 (9 failing tests).**  
   Исправление Admission Finding 3 (`src/host/session-registry.ts:61,79`) ввело жесткую проверку равенства `sessionKey` между родительским тредом и дочерним субтредом, а также между зарегистрированной сессией и повторным запросом. В Beyond Boundaries дочерний субтред имеет собственный сгенерированный `providerThreadId` (и, соответственно, другой `sessionKey`), из-за чего выбрасывается `SessionIdentityMismatchError` при любой попытке привязать subagent child thread к родительской сессии.
2. **[P2 Бюджет строк AP-019] 2 тестовых файла превышают лимит < 200 строк.**  
   - `tests/runtime-graph-source.test.ts`: 390 строк (превышение на 191 строку).
   - `tests/session-admission-race.test.ts`: 239 строк (превышение на 40 строк).

---

## 1. Сводная матрица выполненных свежих проверок

| # | Проверка | Точная команда | Exit code | Результат / Метрики | Лог в thread-storage |
|---|---|---|---|---|---|
| 1 | **Source TSC** | `npx tsc --noEmit` | `0` | **PASS**: 0 ошибок компиляции во всех `src/**/*`, `server.ts`, `app.tsx` | `integrated-2026-10-26-source-tsc.log` |
| 2 | **Contract compiler & negative guard** | `npm run test:contracts` | `0` | **PASS**: `tsc --noEmit -p tsconfig.contract-tests.json` чисто; negative fixture guard подтверждает отказ компилятора `TS2322` | `integrated-2026-10-26-contract-compiler.log` |
| 3 | **Full npm test suite** | `npm test` | `1` | **FAIL**: 496 тестов, 26 сьютов: **487 pass, 9 fail** (duration: 22.25s) | `integrated-2026-10-26-npm-test.log` |
| 4 | **Import AST SCC** | `node scripts/verify-import-graph.mjs && node --test tests/import-graph.test.ts` | `0` | **PASS**: 122 файла `src/`, 0 циклов (Tarjan SCC), 2 теста оракула пройдены | `integrated-2026-10-26-import-scc.log` |
| 5 | **AP-019 Line Budgets (< 200)** | Скрипт подсчёта строк AST/source | `0` (src) / `1` (tests) | `src/`: 22/22 файлов **PASS** (< 200). `tests/`: 2 файла **FAIL** (>= 200). Всего: 105 pass, 2 fail. | `integrated-2026-10-26-line-counts.log` |
| 6 | **Exact Pi 1.4 Tree** | `npm ls @earendil-works/pi-durable @earendil-works/pi-coding-agent @earendil-works/pi-codemode @earendil-works/pi-ai @earendil-works/chord` | `0` | **PASS**: строго `1.4.0` на всех 6 пакетах, без расхождений версий | `integrated-2026-10-26-pi14-tree.log` |
| 7 | **Security Audit** | `npm audit` | `0` | **PASS**: 0 vulnerabilities found | `integrated-2026-10-26-npm-audit.log` |
| 8 | **Source Whitespace** | `git diff --check HEAD -- ':!dist'` + AST scan `src/` | `0` | **PASS**: 128 файлов исходного кода проверены, 0 пробелов на концах строк / 0 CRLF | `integrated-2026-10-26-source-whitespace.log` |
| - | *Vendor Whitespace (dist)* | `git diff --check HEAD dist/` | `2` | *Ожидаемо*: бандлы вендоров в `dist/server.js` содержат trailing whitespace (изолировано в generated dist) | `integrated-2026-10-26-dist-vendor-whitespace.log` |
| 9 | **SDK Types Advisory** | `bb plugin types --check` | `1` | **Advisory**: `@get-bb/plugin-sdk` в dependencies (сохранено, не маскируется) | `integrated-2026-10-26-sdk-types.log` |
| 10 | **Build Candidate** | `npm run build` | `0` | **PASS**: `dist/runner/index.js`, `dist/server.js`, `dist/app.js`, `dist/host.js` успешно пересобраны. Tracked изменения затронули ИСКЛЮЧИТЕЛЬНО `dist/`. | `integrated-2026-10-26-npm-build.log` |

---

## 2. Детальный разбор выявленных дефектов (Findings)

### Finding 1 [P1] Регрессия в `SessionRegistry.createOrGet`: `SessionIdentityMismatchError` ломает присоединение субтредов
- **Evidence:**  
  Файл `src/host/session-registry.ts`, строки 61 и 79:
  ```ts
  // Строка 59-64:
  const existing = this.sessions.get(threadId);
  if (existing && !existing.runner?.exited) {
      const existingKey = parseProviderThreadId(existing.options.providerThreadId).sessionKey;
      if (existingKey !== sessionKey) {
          throw new SessionIdentityMismatchError(`SESSION_IDENTITY_MISMATCH: thread ${threadId} is bound to ${existingKey}, requested ${sessionKey}`);
      }
      return existing;
  }
  // Строка 75-81:
  if (parentThreadId && this.sessions.has(parentThreadId)) {
      const candidate = this.sessions.get(parentThreadId);
      if (candidate && !candidate.runner?.exited) {
          const parentKey = parseProviderThreadId(candidate.options.providerThreadId).sessionKey;
          if (parentKey !== sessionKey) {
              throw new SessionIdentityMismatchError(`SESSION_IDENTITY_MISMATCH: parent thread ${parentThreadId} is bound to ${parentKey}, requested ${sessionKey}`);
          }
  ```
- **Impact:**  
  В архитектуре Beyond Boundaries дочерние субтреды создаются с собственными уникальными `providerThreadId` (например, `pi_durable_child_random_500` или `pi_durable_<timestamp>`), чей `sessionKey` естественным образом отличается от `sessionKey` родителя (`pi_durable_root`).  
  Проверка `parentKey !== sessionKey` категорически запрещает любому дочернему субтреду подключиться к родительской сессии через `attachShared`.  
  Кроме того, когда тред уже привязан к общей сессии через `attachShared`, `existing.options.providerThreadId` хранит ключ корневой сессии, поэтому повторный вызов `createOrGet` для этого треда также падает на строке 61.
- **Rule:** AP-012 (Fail-fast), AP-013 (User data integrity), AP-048 (Identifier consistency).
- **Список упавших тестов (9 тестов):**
  1. `tests/host-subthread-shared-session.scenarios-2.test.ts:13`  
     `handleTurnStart intercepts running subagent turn on child thread and suppresses duplicate prompt`  
     *Error:* `SESSION_IDENTITY_MISMATCH: parent thread thr_parent is bound to pi_durable_root, requested pi_durable_child_random_500`
  2. `tests/host-subthread-shared-session.test.ts:13`  
     `createOrGet reuses existing parent PiThreadSession when params.parentThreadId is provided`  
     *Error:* `SESSION_IDENTITY_MISMATCH: parent thread thr_parent is bound to pi_durable_parent_100, requested pi_durable_random_child_200`
  3. `tests/host-subthread-shared-session.test.ts:59`  
     `createOrGet reuses existing parent PiThreadSession when parent is resolved from DB`  
     *Error:* `SESSION_IDENTITY_MISMATCH: parent thread thr_parent_db is bound to pi_durable_parent_db_100, requested pi_durable_random_child_300`
  4. `tests/host-subthread-shared-session.test.ts:122`  
     `createOrGet resolves targetConversationId from task prompt via findSubagentConversationForTask`  
     *Error:* `SESSION_IDENTITY_MISMATCH: parent thread thr_parent is bound to pi_durable_parent_100, requested pi_durable_random_child_400`
  5. `tests/multimodal-bridge-e2e.test.ts:12`  
     `Multimodal Bridge E2E: turn/start accepts image-only input without -32602 error and calls session.prompt with ImageContent`  
     *Error:* `SESSION_IDENTITY_MISMATCH: thread thr_test_1 is bound to fixture, requested pi_durable_1793007197836`
  6. `tests/subagent-early-completion-race.test.ts:10`  
     `Slice 6.2: Early completion race emits turn.open, accumulated text, turn.boundary, and cleans up memory`  
     *Error:* `SESSION_IDENTITY_MISMATCH: thread thr_child_fast is bound to pi_durable_root, requested pi_durable_1793007201438`
  7. `tests/subagent-live-mirror-e2e.test.ts:12`  
     `End-to-End Mirror Sync: Subagent execution events stream into child BB thread without duplicate prompt or empty transcript`  
     *Error:* `SESSION_IDENTITY_MISMATCH: parent thread thr_parent_live is bound to pi_durable_live, requested pi_durable_child_rand_999`
  8. `tests/subagent-mirror-stream-and-turn-open.test.ts:70`  
     `handleTurnStart: running mirror emits turn.open to prevent 120s timeout`  
     *Error:* `SESSION_IDENTITY_MISMATCH: parent thread thr_parent is bound to fixture, requested pi_durable_1793007203100`
  9. `tests/subagent-mirror-stream-and-turn-open.test.ts:112`  
     `handleTurnStart: completed mirror emits turn.open, accumulated text, and turn.boundary`  
     *Error:* `SESSION_IDENTITY_MISMATCH: parent thread thr_parent is bound to fixture, requested pi_durable_1793007203101`
- **Fix decision:** `fix-now` (требуется точечное исправление в зоне admission: валидация `sessionKey` должна применяться только к root/standalone сессиям или когда запрос явно претендует на управление сессией, но не блокировать `attachShared` дочерних тредов с их собственными `providerThreadId`).

---

### Finding 2 [P2] Нарушение лимита строк AP-019 (< 200 строк) в тестовых файлах
- **Evidence:**  
  - `tests/runtime-graph-source.test.ts`: **390 строк** (> 200).
  - `tests/session-admission-race.test.ts`: **239 строк** (> 200).
- **Impact:**  
  Нарушение правила репозитория AP-019 (hard limit 200). В предыдущих срезах аналогичные файлы разбивались на `.scenarios-2.test.ts` через вспомогательный сплиттер `split-touched-tests.mjs`.
- **Rule:** AP-019 (Лимиты размера и смысловое дробление).
- **Fix decision:** `fix-now` (разбить оба файла сценариев на суб-файлы < 200 строк).

---

## 3. Бюджеты файлов исходного кода (AP-019 Verification)

Все файлы ядра и хоста строго укладываются в лимит AP-019 (< 200 строк):
- `server.ts`: 116 строк
- `src/contracts/wire-lifecycle.ts`: 32 строки
- `src/host/bridge-router.ts`: 181 строка
- `src/host/delta-translator.ts`: 177 строк
- `src/host/runtime-graph-delta.ts`: 28 строк
- `src/host/session-admission.ts`: 175 строк
- `src/host/session-errors.ts`: 24 строки
- `src/host/session-options.ts`: 51 строка
- `src/host/session-port.ts`: 72 строки
- `src/host/session-registry.ts`: 189 строк
- `src/host/session-subagent-handler.ts`: 176 строк
- `src/host/subagent-mirror.ts`: 140 строк
- `src/runner/binding-docs.ts`: 42 строки
- `src/runner/index.ts`: 198 строк
- `src/runner/runtime-graph-conversations.ts`: 44 строки
- `src/runner/runtime-graph-mapper.ts`: 35 строк
- `src/runner/runtime-graph-receipts.ts`: 111 строк
- `src/runner/runtime-graph-scope.ts`: 109 строк
- `src/runner/runtime-graph-source.ts`: 182 строки
- `src/runner/subagent-delivery.ts`: 180 строк
- `src/runner/subagent-docs.ts`: 86 строк
- `src/runner/subagent-policy-ack.ts`: 46 строк
- `src/runtime-graph/schema.ts`: 157 строк
- `src/runtime-graph/status.ts`: 106 строк
- `src/runtime-graph/types.ts`: 128 строк
- `src/ui/runtime-graph/read.ts`: 114 строк
- `src/ui/runtime-graph/subscription.ts`: 96 строк

---

## 4. Статус сборки `dist` и чистота рабочего дерева

- Команда `npm run build` выполнена успешно (`exit code 0`).
- Сгенерированы актуальные бандлы:
  - `dist/runner/index.js` (Pi Durable internal runner с подпиской на Harness и квитанциями)
  - `dist/server.js` (Daemon bridge)
  - `dist/app.js` (Beyond Boundaries Settings UI)
  - `dist/host.js` (Host extension)
- Проверка `git status --porcelain`:  
  Ни один файл в `src/`, `tests/`, `package.json`, `package-lock.json`, `docs/` верификатором **НЕ изменялся**. Изменения затронули исключительно директорию `dist/`.

---

## 5. Граница непроверенного Live Seam (Residual Risks)

В соответствии с контрактом задачи следующие компоненты **НЕ считаются пройденными**:
1. **Runtime graph UI G3 (Live rendering в приложении):** Интеграционные тесты контракта и DOM-чтения `tests/ui/*.test.ts` (9/9) зеленые, но рендеринг реального UI графа в работающем Electron-окне Beyond Boundaries остаётся непроверенным live seam до запуска установленного плагина.
2. **Живой транспортный roundtrip Beyond Boundaries:** Реальная доставка и персистенция событий `thread/extensionState/updated` в локальную SQLite БД десктопного приложения требует работающего десктопного процесса и согласованного перезапуска хост-демона.

---

## 6. Рекомендации оркестратору

Для перехода в состояние **PASS** оркестратору необходимо поставить следующие узкие задачи:
1. **Remediation в `src/host/session-registry.ts`:**  
   Скорректировать проверку идентичности сессионных ключей так, чтобы она валидировала соответствие между реальным SQLite файлом сессии и запросом, но **не блокировала привязку дочерних субтредов** к сессии родителя через `attachShared`.
2. **Сплит тестовых файлов по AP-019:**  
   Разбить `tests/runtime-graph-source.test.ts` (390 строк) и `tests/session-admission-race.test.ts` (239 строк) на модули сценариев `< 200` строк.
3. Повторить интеграционную верификацию после этих двух точечных исправлений.
