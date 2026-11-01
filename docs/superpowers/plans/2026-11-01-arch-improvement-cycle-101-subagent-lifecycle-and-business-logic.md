# Cycle 101: Sovereign Subagents & Anti-Fragile Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all critical business logic and subagent lifecycle defects (3x P0, 6x P1, 1x P2: BL-01..BL-10) discovered in audit thr_nzuzxj3a5u, ensuring subagents launch reliably in Beyond Boundaries with zero layer boundary leaks, zero regression, and 100% test pass rate.

**Architecture:** Ports & Adapters (Hexagonal Architecture) with strict layer firewall isolation between Host (`src/host/`), Runner (`src/runner/`), Domain (`src/runtime-graph/`), Contracts (`src/contracts/`), and Shared (`src/shared/`). All model references are canonicalized through a pure shared domain normalizer (`src/shared/model-ref.ts`), eliminating prefix desyncs across CLI and RPC boundaries. Session lock contention fails closed without destructive process termination.

**Tech Stack:** TypeScript, Node.js (`node:test`, `node:sqlite`), `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord`, Zod.

**Layer Boundary Firewall Invariant:** Every single task MUST run `node scripts/verify-layer-boundaries.mjs` to ensure 0 imports between `src/runner/` and `src/host/`.

---

## 🔍 Инженерное расследование и верификация по первоисточникам

Каждый дефект был лично перепроверен по коду репозитория `bb-plugin-provider-pi-durable` и зависимостей `@earendil-works/pi-durable` / `@earendil-works/pi-ai`. Ниже приведены доказанные факты, анализ рисков и стратегия предотвращения регрессий:

| ID | Доказанный факт в коде | Механизм сбоя (Root Cause) | Blast Radius (Что может задеть) | Защита от регрессий (Test Strategy) |
| :--- | :--- | :--- | :--- | :--- |
| **BL-01** | `src/runner/subagent.ts:72`, `src/policy/resolver.ts:39` | `subagent.ts` читает `parentAgent.model.modelId`. В рантайме Pi AI/Pi Durable модели часто хранятся как `{ provider, id }` (или `undefined` при reopen сессии). `resolver.ts` строго требует `parentContext.model?.modelId`, падая с `SubagentPolicyInvalidError`. | Изменение резолюции модели субагента в режиме `inherit`. | Тесты `tests/red-subagent-model-resolution.test.ts` проверяют наследование при форматах `{ provider, modelId }`, `{ provider, id }`, а также fallback на дефолтную модель. Существующие тесты политик (22 теста) должны остаться зелёными. |
| **BL-02** | `src/host/subthread-spawner.ts:128` | Код делает `cliArgs.push("--model", `${provider}/${modelId}`)`. Если `modelId` уже был с префиксом (`antigravity/gemini-3.8-flash`), в CLI уходит `--model antigravity/antigravity/gemini-3.8-flash`. `resolveCliModel` падает в раннере на старте. | Форматирование аргументов CLI для дочернего процесса `bb thread spawn`. | Тест `tests/subthread-spawner-model-args.test.ts` проверяет все комбинации префиксов (с префиксом, без, openrouter модели со слэшами `openrouter/google/gemini`). |
| **BL-03** | `src/runner/session-storage.ts:107-133` | При конфликте блокировки живого раннера (`isAlive && isRunner`) код посылает `process.kill(owner.pid, "SIGTERM")`. Если дочерний тред запускает раннер на той же сессии, он убивает родительский процесс. | Механизм разрешения конфликтов lockfile в `acquireSessionLock`. | Проверка: stale lockfiles от мёртвых процессов (`!isProcessAlive`) по-прежнему очищаются через forceUnlock, но живые процессы НЕ убиваются, а возвращают `SessionAlreadyLockedError`. Все 11 тестов `session-storage-*.test.ts` проходят. |
| **BL-04** | `src/runner/subagent-courier.ts:70-80` | Если родительский ход отменён, `submission.wait()` завершается с `unanswered`. Курьер переходит в `hold` на 5с, затем снова в `send` с ТЕМ ЖЕ `sending.requestId`. Pi Durable возвращает из кеша тот же `unanswered` мгновенно. Вечный цикл каждые 5с. | Доставка отчётов завершившихся субагентов в родительскую сессию. | Тест `tests/subagent-courier-lifecycle.test.ts` проверяет ротацию `requestId` (attempt counter) и доставку после отмены предыдущего хода. |
| **BL-05** | `src/policy/resolver.ts:50-61` | В `availableModels` модели хранятся с чистым `m.id === "gemini-3.8-flash"`. В `configuredProfile.model.modelId` UI сохраняет `antigravity/gemini-3.8-flash`. Поиск `m.id === modelId` возвращает `undefined` и выбрасывает `SubagentModelUnavailableError`. | Резолюция моделей субагентов в режиме `configured`. | Тест проверяет поиск модели с префиксом провайдера и без префикса против каталога Pi AI. |
| **BL-06** | `src/host/subthread-spawner.ts:165`, `src/host/session-subagent-handler.ts:107` | Исключения `bb thread spawn` перехватываются через `catch` и пишутся в `console.warn`, возвращая `undefined`. В родительский тред не поступает никакой нотификации о сбое. | Обработка ошибок спавна в хосте. | Добавление явного предупреждения/диагностики в поток родительской сессии при сбое спавна дочернего треда. |
| **BL-07** | `src/host/child-turn-guard.ts:140` | Строгое сравнение `reqModel.modelId !== actualModel.modelId` без нормализации префикса блокирует Turn 1 дочернего треда ошибкой `-32602 CHILD_MODEL_POLICY_LOCKED`. | Валидация ходом модели в дочернем треде. | Тест проверяет, что эквивалентные идентификаторы моделей (с префиксом и без) считаются совпадающими. |
| **BL-08** | `src/host/session-registry.ts:211` | При `stop(threadId)` родителя сессия не закрывается, если есть дочерние треды, и не вызывается каскадный `session.abort()`. Фоновые субагенты продолжают жить и жечь токены. | Остановка сессий в реестре хоста. | Тест `tests/session-stop-cascading-abort.test.ts` проверяет вызов каскадного аборта родительской сессии при остановке родительского треда. |
| **BL-09** | `src/host/diagnostics.ts:52` | Проверка `defaultModelAvailable` вызывается ДО загрузки расширений, поэтому провайдер `antigravity` ещё не зарегистрирован, что даёт ложный `WARNING` в `doctor.mjs`. | CLI-команда `npm run doctor`. | Запуск `npm run doctor` выдаёт чистый `HEALTHY` без ложных предупреждений. |
| **BL-10** | `src/runner/runtime-graph-source.ts:25`, `src/runner/task-labels.ts:58` | Карты `nativeStartedAt` и `TaskNames.names/details` растут бесконечно в длинных сессиях без LRU/FIFO лимита. | Память графа задач в раннере. | Ограничение размера коллекций до 256/512 записей с удалением старейших ключей. 117 UI тестов и 35 тестов графа проходят. |

---

## 🛡️ Архитектурные инварианты и матрица слоёв

1. **Rule 1 (AP-025):** `src/runner/` НИКОГДА не импортирует ничего из `src/host/`.
2. **Rule 2 (AP-020):** `src/host/` НИКОГДА не импортирует ничего из `src/runner/`.
3. **Rule 3 (AP-026):** `src/contracts/` не имеет зависимостей от `runner` или `host`.
4. **Rule 4 (AP-010):** `src/shared/model-ref.ts` — чистый модуль (чистые типы и строковые функции, 0 побочных эффектов).
5. **Rule 5 (AP-019):** Все файлы строго < 200 строк (hard ceiling 250 строк).
6. **Rule 6 (AP-023):** Все новые и существующие тесты обязаны объявлять `{ timeout: N }`.

---

## План пошаговой реализации (TDD Slices)

### Task 1: Канонический нормализатор ModelRef (BL-01, BL-02, BL-05, BL-07)

**Файлы:**
- Создать: `src/shared/model-ref.ts`
- Тест: `tests/model-ref-normalization.test.ts`

- [ ] **Step 1: Написать падающий тест**
Создать `tests/model-ref-normalization.test.ts` с проверкой парсинга `{ provider, modelId }`, `{ provider, id }`, стрипинга префикса `provider/` и форматирования аргумента CLI.
- [ ] **Step 2: Запустить тест и убедиться в падении**
`node --test tests/model-ref-normalization.test.ts` (FAIL: module not found).
- [ ] **Step 3: Реализовать минимальный код `src/shared/model-ref.ts`**
Функции `normalizeModelReference(raw, defaultProvider?)` и `formatModelCliArg(ref)`.
- [ ] **Step 4: Запустить тест и убедиться в прохождении**
`node --test tests/model-ref-normalization.test.ts` (PASS).
- [ ] **Step 5: Проверить фаервол слоёв**
`node scripts/verify-layer-boundaries.mjs` (0 violations).
- [ ] **Step 6: Коммит**
`git add src/shared/model-ref.ts tests/model-ref-normalization.test.ts && git commit -m "feat(shared): add canonical model reference normalizer"`

---

### Task 2: Резолюция моделей субагентов и иммунитет к префиксам (BL-01, BL-05)

**Файлы:**
- Модифицировать: `src/policy/resolver.ts`
- Модифицировать: `src/runner/subagent.ts`
- Тест: `tests/red-subagent-model-resolution.test.ts`
- Регрессия: `tests/subagent-policy-error-handling.test.ts`

- [ ] **Step 1: Написать падающий тест**
Создать `tests/red-subagent-model-resolution.test.ts` (кейсы: `inherit` с `.id` вместо `.modelId`, `configured` с префиксом провайдера в `modelId`, fallback на дефолтную модель при отсутствии модели у родителя).
- [ ] **Step 2: Запустить тест и убедиться в падении**
`node --test tests/red-subagent-model-resolution.test.ts` (FAIL: `SubagentPolicyInvalidError` / `SubagentModelUnavailableError`).
- [ ] **Step 3: Внедрить нормализацию в `src/policy/resolver.ts` и `src/runner/subagent.ts`**
Использовать `normalizeModelReference`. В `subagent.ts` извлекать родительскую модель через нормализатор. При отсутствии модели у родительского агента брать активную модель из настроек рантайма до выброса ошибки.
- [ ] **Step 4: Запустить тесты и проверить регрессии**
`node --test tests/red-subagent-model-resolution.test.ts tests/subagent-policy-error-handling.test.ts` (PASS).
- [ ] **Step 5: Проверить фаервол слоёв и лимиты строк (AP-019)**
`node scripts/verify-layer-boundaries.mjs && wc -l src/policy/resolver.ts src/runner/subagent.ts` (< 200 строк).
- [ ] **Step 6: Коммит**
`git add src/policy/resolver.ts src/runner/subagent.ts tests/red-subagent-model-resolution.test.ts && git commit -m "fix(policy): normalize model references in inherit and configured modes"`

---

### Task 3: Чистый флаг --model в CLI спавнера и Child Turn Guard (BL-02, BL-07)

**Файлы:**
- Модифицировать: `src/host/subthread-spawner.ts`
- Модифицировать: `src/host/child-turn-guard.ts`
- Тест: `tests/subthread-spawner-model-args.test.ts`
- Регрессия: `tests/child-turn-guard.test.ts`

- [ ] **Step 1: Написать падающий тест**
Создать `tests/subthread-spawner-model-args.test.ts` (проверка отсутствия `--model antigravity/antigravity/...`, корректный разбор моделей openrouter). В `child-turn-guard` проверить turn validation с префиксом и без.
- [ ] **Step 2: Запустить тест и убедиться в падении**
`node --test tests/subthread-spawner-model-args.test.ts` (FAIL).
- [ ] **Step 3: Применить `formatModelCliArg` в `subthread-spawner.ts` и `normalizeModelReference` в `child-turn-guard.ts`**
В `buildSpawnArgs` передавать `formatModelCliArg(args.actualModel)`. В `validateChildTurn` сравнивать нормализованные `provider` и `modelId`.
- [ ] **Step 4: Запустить тесты и проверить регрессии**
`node --test tests/subthread-spawner-model-args.test.ts tests/subagent-mirror-guard.test.ts` (PASS).
- [ ] **Step 5: Проверить фаервол слоёв и лимиты строк (AP-019)**
`node scripts/verify-layer-boundaries.mjs && wc -l src/host/subthread-spawner.ts src/host/child-turn-guard.ts` (< 200 строк).
- [ ] **Step 6: Коммит**
`git add src/host/subthread-spawner.ts src/host/child-turn-guard.ts tests/subthread-spawner-model-args.test.ts && git commit -m "fix(host): clean CLI model flags and child turn model comparison"`

---

### Task 4: Исключение деструктивного SIGTERM из Session Lock (BL-03)

**Файлы:**
- Модифицировать: `src/runner/session-storage.ts`
- Тест: `tests/session-storage-pid-safety.test.ts`
- Регрессия: `tests/session-lock-eviction.test.ts`

- [ ] **Step 1: Написать падающий тест**
В `tests/session-storage-pid-safety.test.ts` добавить сценарий: если lockfile занят живым раннером, `acquireSessionLock` НЕ вызывает `process.kill(SIGTERM)`, а выбрасывает `SessionAlreadyLockedError`.
- [ ] **Step 2: Запустить тест и убедиться в поведении**
`node --test tests/session-storage-pid-safety.test.ts`
- [ ] **Step 3: Удалить вызов `process.kill(SIGTERM)` для живых процессов в `session-storage.ts`**
Оставить эвикцию только для мёртвых процессов (`!isProcessAlive(owner.pid)`). Для живых чужих процессов немедленно выбрасывать ошибку с PID владельца.
- [ ] **Step 4: Запустить тесты и проверить регрессии**
`node --test tests/session-storage-pid-safety.test.ts tests/session-lock-eviction.test.ts` (PASS).
- [ ] **Step 5: Проверить фаервол слоёв и лимиты строк (AP-019)**
`node scripts/verify-layer-boundaries.mjs && wc -l src/runner/session-storage.ts` (< 200 строк).
- [ ] **Step 6: Коммит**
`git add src/runner/session-storage.ts tests/session-storage-pid-safety.test.ts && git commit -m "fix(runner): remove destructive SIGTERM in session lock acquisition"`

---

### Task 5: Ротация requestId в курьере при unanswered сабмишне (BL-04)

**Файлы:**
- Модифицировать: `src/runner/subagent-courier.ts`
- Тест: `tests/subagent-courier-lifecycle.test.ts`

- [ ] **Step 1: Написать падающий тест**
В `tests/subagent-courier-lifecycle.test.ts` проверить, что при переходе из `hold` в `next`/`send` генерируется новый `requestId` (с инкрементом суффикса попытки), чтобы обойти кеш завершённого сабмишна в Pi Durable.
- [ ] **Step 2: Запустить тест и убедиться в падении**
`node --test tests/subagent-courier-lifecycle.test.ts`
- [ ] **Step 3: Реализовать ротацию `requestId` в `subagent-courier.ts`**
Инкрементировать `retries` в объекте `sending` и использовать `subagent-batch:${task.id}:${batch}:r${retries}` при повторной отправке.
- [ ] **Step 4: Запустить тесты и проверить регрессии**
`node --test tests/subagent-courier-lifecycle.test.ts tests/subagent.test.ts` (PASS).
- [ ] **Step 5: Проверить фаервол слоёв и лимиты строк (AP-019)**
`node scripts/verify-layer-boundaries.mjs && wc -l src/runner/subagent-courier.ts` (< 200 строк).
- [ ] **Step 6: Коммит**
`git add src/runner/subagent-courier.ts tests/subagent-courier-lifecycle.test.ts && git commit -m "fix(runner): rotate requestId on courier retry to prevent unanswered deadlock"`

---

### Task 6: Каскадный abort при thread/stop и нотификация сбоев спавна (BL-06, BL-08)

**Файлы:**
- Модифицировать: `src/host/session-registry.ts`
- Модифицировать: `src/host/session-subagent-handler.ts`
- Тест: `tests/session-stop-cascading-abort.test.ts`
- Регрессия: `tests/session-registry.test.ts`

- [ ] **Step 1: Написать падающий тест**
Создать `tests/session-stop-cascading-abort.test.ts`: при остановке родительского треда `session.abort({ background: true })` вызывается для завершения фоновых субагентов; сбой `spawnSubthreadInBb` эмитирует предупреждающее событие.
- [ ] **Step 2: Запустить тест и убедиться в падении**
`node --test tests/session-stop-cascading-abort.test.ts` (FAIL).
- [ ] **Step 3: Реализовать каскадный аборт в `session-registry.ts` и нотификацию в `session-subagent-handler.ts`**
В `SessionRegistry.stop(threadId)`: если тред является владельцем сессии, вызвать `await session.abort({ background: true })`. В `session-subagent-handler.ts` при возврате `undefined` из спавнера логировать предупреждение в родительский поток событий.
- [ ] **Step 4: Запустить тесты и проверить регрессии**
`node --test tests/session-stop-cascading-abort.test.ts tests/session-registry.test.ts` (PASS).
- [ ] **Step 5: Проверить фаервол слоёв и лимиты строк (AP-019)**
`node scripts/verify-layer-boundaries.mjs && wc -l src/host/session-registry.ts src/host/session-subagent-handler.ts` (< 250 строк).
- [ ] **Step 6: Коммит**
`git add src/host/session-registry.ts src/host/session-subagent-handler.ts tests/session-stop-cascading-abort.test.ts && git commit -m "fix(host): cascading abort on thread stop and visible spawn error notification"`

---

### Task 7: Порядок проверки в doctor.mjs и ограничение памяти графа задач (BL-09, BL-10)

**Файлы:**
- Модифицировать: `src/host/diagnostics.ts`
- Модифицировать: `src/runner/runtime-graph-source.ts`
- Модифицировать: `src/runner/task-labels.ts`
- Тест: `tests/diagnostics-init-order.test.ts`
- Регрессия: `tests/runtime-graph-*.test.ts`, `tests/ui/runtime-graph-*.test.ts`

- [ ] **Step 1: Написать падающий тест**
Создать `tests/diagnostics-init-order.test.ts`: проверить LRU-очистку в `RuntimeGraphSource` (>256 записей) и в `TaskNames` (>512 записей).
- [ ] **Step 2: Запустить тест и убедиться в падении**
`node --test tests/diagnostics-init-order.test.ts` (FAIL).
- [ ] **Step 3: Реализовать LRU-окна и перенести проверку доступности модели в `diagnostics.ts`**
В `diagnostics.ts` выполнять `modelRuntime.getModel` ПОСЛЕ `resourceLoader.reload()`. В `RuntimeGraphSource` и `TaskNames` удалять старейшие ключи при превышении емкости.
- [ ] **Step 4: Запустить тесты и проверить регрессии**
`node --test tests/diagnostics-init-order.test.ts && tsx --test tests/ui/runtime-graph-tree.test.ts` (PASS).
- [ ] **Step 5: Проверить фаервол слоёв и лимиты строк (AP-019)**
`node scripts/verify-layer-boundaries.mjs && wc -l src/host/diagnostics.ts src/runner/runtime-graph-source.ts src/runner/task-labels.ts` (< 200 строк).
- [ ] **Step 6: Коммит**
`git add src/host/diagnostics.ts src/runner/runtime-graph-source.ts src/runner/task-labels.ts tests/diagnostics-init-order.test.ts && git commit -m "fix(runner,host): bound task graph memory and fix doctor model diagnostic order"`

---

### Task 8: Полная двухконтурная верификация, леджер и релиз v0.4.2

**Файлы:**
- Модифицировать: `package.json`, `package-lock.json` (bump to 0.4.2)
- Модифицировать: `docs/arch-improvement/ledger.md`
- Модифицировать: `docs/arch-improvement/memory.md`

- [ ] **Step 1: Запустить полный автоматизированный сьют проверок**
```bash
npm run test:contracts
node scripts/verify-layer-boundaries.mjs
node scripts/verify-import-graph.mjs
npm test
npm run doctor
```
Ожидается: >= 735 тестов pass, 0 fail, 0 boundary violations, 0 cycles, Doctor healthy.
- [ ] **Step 2: Проверить лимиты строк AP-019**
`find src -name "*.ts" -o -name "*.tsx" | xargs wc -l | sort -n | tail -n 15` (100% файлов < 250 LOC).
- [ ] **Step 3: Пересобрать дистрибутивы**
`npm run build`
- [ ] **Step 4: Обновить леджер и накопленную память**
Зафиксировать результаты Cycle 101 в `docs/arch-improvement/ledger.md` и уроки в `docs/arch-improvement/memory.md`.
- [ ] **Step 5: Выпустить релиз v0.4.2**
```bash
git add -A
git commit -m "release(v0.4.2): complete Cycle 101 Sovereign Subagents and Anti-Fragile Lifecycle"
git tag -a v0.4.2 -m "Release v0.4.2: Sovereign Subagents & Anti-Fragile Lifecycle"
```
