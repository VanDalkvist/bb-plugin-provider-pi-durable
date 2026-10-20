# Cycle 93: Upstream Pi 1.3 Parity, Task Graph PlanSteps, Inbound PRs & Resilient Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` orchestrated via `arch-improvement-loop` and `arch-rules-implementation-review`. Every step executes via a dedicated worker thread, followed by an independent review thread. После каждого шага или фикса замечаний ревью обязательно инкрементируется версия в `package.json` (`0.2.x + 1`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Систематически и детерминированно модернизировать `bb-plugin-provider-pi-durable`: интегрировать проверенные пулл-реквесты (#20, #22, #16), обновить ядро до upstream `@earendil-works/pi-durable@1.3.0` с удалением устаревших костылей, и внедрить лучшие архитектурные решения по надежной фоновой доставке сабагентов (Reporter + Courier) и персистентному хранению связок тредов в SQLite (Durable Binding Store) без единой правки ядра BB IDE.

**Architecture:** Архитектура базируется на фундаментальном инварианте **The Four Territories & Thin Bridge** (GoF Adapter). BB IDE выступает клиентом UI и хостом (`@get-bb/plugin-sdk`), раннер плагина управляет транзакционным рантаймом `@earendil-works/pi-durable`, а расширения (`subagent`, `tasks`, `bindings`) строятся строго поверх публичных FSM-задач (`defineTask`), документов (`defineDoc`) и транзакций SQLite. Все модули строго подчиняются лимитам AP-019 (<200 строк в `src/runner/`, <250 строк в `src/host/`).

**Tech Stack:** TypeScript 5.7+, Node.js >= 22.19.0 (built-in `node:sqlite`), `@earendil-works/pi-durable@1.3.0`, `@earendil-works/chord@1.3.0`, `@earendil-works/pi-coding-agent@1.3.0`, `@earendil-works/pi-ai@1.3.0`, `@get-bb/plugin-sdk@0.6.15`.

---

## 1. Multi-Agent Orchestration & Continuous Versioning Protocol

В соответствии с правилами рабочего пространства (`~/Projects/AGENTS.md`) и скиллами `arch-improvement-loop`, `subagent-driven-development`, `arch-rules-implementation-review`:

1. **Роль Оркестратора (Lead Agent):**
   - Управляет состоянием арх-лупа (S0–S12), координирует передачу контекста и контролирует чекбоксы плана.
   - **Запрет на микроменеджмент:** Не пишет код руками за воркеров.
   - Делегирует исполнение шага воркеру, передавая изолированный контекст и строгие guardrails (ЧТО ДЕЛАТЬ / ЧЕГО НЕ ДЕЛАТЬ).
   - После завершения шага воркером запускает независимый субтред-ревьюер. Принимает работу только при вердикте `VERDICT: PASS`.

2. **Стандарт запуска субтредов (Hard Rule):**
   Все субтреды (и воркеры, и ревьюеры) запускаются строго через:
   ```bash
   bb thread spawn \
     --project proj_t4zxb4pcrk \
     --provider pi-durable \
     --model antigravity/gemini-3.8-flash \
     --reasoning-level high \
     --parent-self \
     --title "<Phase/Step Name>" \
     --prompt-file <path-to-prompt> \
     --json
   ```
   *Запрещено указывать `claude-sonnet-4-6` или другие модели в субтредах.*

3. **Стандарт Архитектурного Ревью (Review Gate):**
   Ревьюер обязан:
   - Проверять код строго по правилам `arch-rules.md` (AP-010 ... AP-071).
   - Формулировать замечания в каноничном Finding Format:
     ```markdown
     - [P1] <AP-ID>: <file:line> <Evidence and Impact>
       - Fix decision: fix-now | log-only | blocked
     ```
   - Завершать отчет секцией `Architecture verification` с перечнем `Passed: AP-###` и итоговым вердиктом `VERDICT: PASS` или `VERDICT: FAIL`.

4. **Политика пошагового бампа версий (Continuous Step-by-Step Version Bump):**
   - Текущая базовая версия: **`0.2.30`**.
   - После успешного завершения **каждого шага** и получения `VERDICT: PASS` от независимого ревьюера выполняется бамп версии: `0.2.x + 1` в `package.json`.
   - Если ревьюер находит дефекты (P1/P2), воркер выполняет исправление, ревьюер проводит повторную приёмку, и результат исправления фиксируется с собственным бампом версии `0.2.x + 1`.
   - Это гарантирует полную атомарность истории, воспроизводимость каждого промежуточного состояния и возможность отката к любому конкретному шагу.

---

## 2. File Structure & Responsibilities (Декомпозиция модулей и лимиты AP-019)

### Host Territory (`src/host/`, лимит < 250 строк):
- `src/host/paths.ts` (142 строки): чистые пути к окружению BB, без угадываний чужих директорий.
- `src/host/runner-lookup.ts` (125 строк, PR #20): надежный поиск раннера из развернутого `plugin-host-artifacts/<pluginId>/<digest>/`.
- `src/host/runner-prompts.ts` (51 строка, PR #22): создание и очистка защищенных временных файлов промптов (`0o600` в `0o700`).
- `src/host/runner-process.ts` (173 строки, PR #22): запуск подпроцесса раннера с аргументами промптов и гарантированным cleanup.
- `src/host/delta-translator.ts` (146 строк, PR #16): трансляция событий раннера в BB, включая `tasks_snapshot` → `planSteps`.
- `src/host/durable-binding-store.ts` (~140 строк, NEW): `DurableBindingManager` — L1 in-memory кэш связок `bbThreadId <-> conversationId` с RPC к раннеру и offline fallback на `node:sqlite`.
- `src/host/session.ts` (сокращается с 240 до ~195 строк): делегирует связки тредов в `DurableBindingManager`.

### Runner Territory (`src/runner/`, лимит < 200 строк):
- `src/runner/task-labels.ts` (78 строк, PR #16): именование шагов графа задач на основе `pi.live` и аргументов тулов.
- `src/runner/task-graph-bridge.ts` (~75 строк, PR #16 + дебаунс): сглаживание и публикация TaskGraph в `tasks_snapshot` с поддержкой `unsubscribe()`.
- `src/runner/child-title.ts` (~35 строк, NEW, из Track 1): санитизация заголовков тредов `nativeChildTitle(name, role, model)` (лимит 494 символа).
- `src/runner/bridge/bb-child-event-adapter.ts` (116 строк, Track 1): `message_end flush` — досыл хвостовой дельты при завершении сообщения.
- `src/runner/subagent-docs.ts` (~95 строк, NEW, Track 4): схема документа `SubagentsDoc` (`agents`, `outbox`, `sending`, `deliveryHold`).
- `src/runner/subagent-delivery.ts` (~175 строк, NEW, Track 4): FSM-задачи `Anchor`, `Reporter`, `Courier` (50ms debounce, `parent.submit({ whenBusy: "followUp" })`).
- `src/runner/subagent.ts` (~165 строк, refactored): точка входа расширения `subagent`, создающая задачи и связывающая их с `SubagentsDoc`.
- `src/runner/binding-docs.ts` (~110 строк, NEW, Track 4): схема документов `BindingDoc` (`scope: conversation`) и `BindingIndexDoc` (`scope: session`).
- `src/runner/bridge/tool-result-extractor.ts`: удаление костыля `sanitizeToolResultForAnthropic` после апгрейда `pi-ai@1.3.0`.

---

## 3. Implementation Phases with Positive & Negative Guardrails, Review Gates and Version Bumps

---

### Phase 1: Host Stability Foundation (PR #20 ➔ PR #22)

#### Task 1.1: Merge PR #20 (Deterministic Runner Resolution)
- **Primary Source / Evidence:** PR #20 (`fix/runner-resolution`), commit `d4d521a`. Решает issue #18.
- **Touched Files:**
  - Create: `src/host/runner-lookup.ts`
  - Modify: `src/host/paths.ts`
  - Modify: `tests/runner-discovery.test.ts`
  - Modify: `tests/startup-readiness.test.ts`
- **AP Gates:** AP-010 (Decoupled Lookup), AP-019 (File size < 250), AP-028 (No swallowed errors).

- **ЧТО ДЕЛАТЬ (DO):**
  - [ ] Выполнить слияние PR #20 через git merge `origin/pull/20/head`.
  - [ ] Проверить, что путь к `dataDir` вычисляется строго из пути развернутого бандла `plugin-host-artifacts/<pluginId>/<digest>/`.
  - [ ] Сохранить fallback на `BB_DATA_DIR` и `~/.bb` strictly как резервные пути.
  - [ ] Запустить `npm test` и убедиться, что 211 из 211 тестов проходят.

- **ЧЕГО НЕ ДЕЛАТЬ (DO NOT):**
  - ⛔ НЕ менять дефолтную директорию сессий `~/.bb/pi-bridge-sessions` (чтобы не потерять сессии пользователей).
  - ⛔ НЕ увеличивать `paths.ts` выше 150 строк (вся сложная логика остается в `runner-lookup.ts`).
  - ⛔ НЕ удалять timeout ceiling в `startup-readiness.test.ts`.

- [ ] **Review Gate 1.1:** Запустить субтред-ревьюер по AP-010, AP-019, AP-028.
  - Критерий прохождения: Отсутствие регрессий резолвинга, `paths.ts` <= 145 строк, 211/211 тестов GREEN, вердикт `VERDICT: PASS`.
- [ ] **Version Bump 1.1:** Повысить версию до **`0.2.31`** в `package.json`, закоммитить:
  `chore(release): bump version to 0.2.31 (PR #20 merged and verified)`.

---

#### Task 1.2: Merge PR #22 (Preserve BB System Instructions)
- **Primary Source / Evidence:** PR #22 (`fix/bb-context-parity`), commit `07c6f01`.
- **Touched Files:**
  - Create: `src/host/runner-prompts.ts`
  - Modify: `src/host/runner-process.ts`
  - Modify: `src/host/session-registry.ts`
  - Modify: `src/host/session.ts`
  - Test: `tests/bb-instructions-parity.test.ts`
- **AP Gates:** AP-010 (Thin Bridge), AP-013 (Process Isolation), AP-019 (<250 lines), AP-023 (Resource Cleanup).

- **ЧТО ДЕЛАТЬ (DO):**
  - [ ] Выполнить слияние PR #22 через git merge `origin/pull/22/head`.
  - [ ] Обеспечить создание временной папки промптов с правами `0o700` (`mkdtempSync`).
  - [ ] Писать файлы промптов строго с правами `0o600`.
  - [ ] Гарантировать вызов `cleanPromptDir()` как при успешном завершении процесса, так и при аварийном сбое (`child.on("exit")`, `child.on("error")`, блок `catch`).
  - [ ] Убедиться, что проходят 216 из 216 тестов.

- **ЧЕГО НЕ ДЕЛАТЬ (DO NOT):**
  - ⛔ НЕ писать системные промпты в общие директории (`/tmp` без изолированного префикса).
  - ⛔ НЕ генерировать собственные системные инструкции в адаптере — только транслировать входящие из BB Core.
  - ⛔ НЕ оставлять «висячие» временные файлы на диске при аварийной остановке раннера.

- [ ] **Review Gate 1.2:** Запустить субтред-ревьюер по AP-010, AP-013, AP-019, AP-023.
  - Критерий прохождения: Права файлов 0600/0700, гарантированный cleanup, все файлы < 250 строк, вердикт `VERDICT: PASS`.
- [ ] **Version Bump 1.2:** Повысить версию до **`0.2.32`** в `package.json`, закоммитить:
  `chore(release): bump version to 0.2.32 (PR #22 merged and verified)`.

---

### Phase 2: Upstream Pi 1.3.0 Parity & Workaround Removal

#### Task 2.1: Upgrade Dependencies to `@earendil-works/*@1.3.0` & Prune Workarounds
- **Primary Source / Evidence:** Upstream tags and packages in `/Users/vanya/Projects/pi` (`v1.3.0`, commit `71023aec1`, `f7e3cb543`, `5ab7fe74c`).
- **Touched Files:**
  - Modify: `package.json`
  - Modify: `package-lock.json`
  - Modify: `src/runner/bridge/tool-result-extractor.ts`
  - Modify: `src/runner/tool-adapter.ts`
- **AP Gates:** AP-010 (Thin Bridge), AP-026 (State Persistence), AP-029 (Zero Type Casts).

- **ЧТО ДЕЛАТЬ (DO):**
  - [ ] Обновить версии `@earendil-works/chord`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-durable`, `@earendil-works/pi-codemode` до `1.3.0` в `package.json` и `overrides`.
  - [ ] Удалить локальную функцию `sanitizeToolResultForAnthropic` в `tool-result-extractor.ts` — в `pi-ai@1.3.0` санитизация изображений в блоках ошибок тулов теперь выполняется нативно (`splitErrorToolResultImages`).
  - [ ] Запустить `npx tsc --noEmit` и убедиться в отсутствии ошибок типов.
  - [ ] Запустить полный сьют `npm test`.

- **ЧЕГО НЕ ДЕЛАТЬ (DO NOT):**
  - ⛔ НЕ оставлять старые костыли, если upstream уже предоставляет официальное решение.
  - ⛔ НЕ допускать рассинхрона версий между пакетами `@earendil-works/*` (все обязаны быть строго `1.3.0`).
  - ⛔ НЕ трогать настройки компакшна без сверки с новым `findBaseline()` из Durable 1.3.0.

- [ ] **Review Gate 2.1:** Запустить субтред-ревьюер по AP-010, AP-026, AP-029.
  - Критерий прохождения: Чистый `npx tsc --noEmit`, удаление дублирующего кода, прохождение всех тестов, вердикт `VERDICT: PASS`.
- [ ] **Version Bump 2.1:** Повысить версию до **`0.2.33`** в `package.json`, закоммитить:
  `chore(release): bump version to 0.2.33 (Upstream Pi 1.3.0 parity)`.

---

### Phase 3: Live Task Graph PlanSteps (PR #16 + Polish)

#### Task 3.1: Integrate Live Task Graph with Debounce and Teardown
- **Primary Source / Evidence:** PR #16 (`feat/durable-task-graph`), Review findings Track 3 (`track-3-inbound-prs-audit.md`).
- **Touched Files:**
  - Create: `src/runner/task-labels.ts` (78 строк)
  - Create: `src/runner/task-graph-bridge.ts` (~80 строк)
  - Modify: `src/host/delta-translator.ts:130-145`
  - Modify: `src/runner/bridge/contracts.ts`
  - Modify: `src/runner/index.ts`
  - Test: `tests/task-graph-bridge.test.ts`
- **AP Gates:** AP-011 (Lifecycle Cleanup), AP-019 (<200 lines), AP-023 (Zero Leaks), AP-045 (Coalesced Events).

- **ЧТО ДЕЛАТЬ (DO):**
  - [ ] Внедрить `task-labels.ts` для извлечения читаемых имен тулов и аргументов из `pi.live` (максимум 48 символов, одна строка).
  - [ ] В `task-graph-bridge.ts` реализовать таймерный дебаунс в **50 мс** для вызова `output({ type: "tasks_snapshot", steps })`.
  - [ ] Возвращать функцию отписки `unsubscribe()` из `startTaskGraphBridge` и вызывать её в `teardown()` раннера.
  - [ ] В `delta-translator.ts` транслировать `tasks_snapshot` в нативный BB контракт `planSteps` через `experimental_planStepsPresentation`.
  - [ ] Исключить бинарник `dist/runner/index.js` из коммита (ребилд будет в Phase 5).
  - [ ] Добавить тесты на проверку дебаунса и очистки подписки.

- **ЧЕГО НЕ ДЕЛАТЬ (DO NOT):**
  - ⛔ НЕ спамить в сокет хоста снапшотами графа на каждое изменение токена или микротаски.
  - ⛔ НЕ оставлять висящие подписки на `view.subscribe` после остановки сессии.
  - ⛔ НЕ коммитить предсобранные бандлы `dist/` в фиче-ветку.
  - ⛔ НЕ превышать лимит в 200 строк в `task-graph-bridge.ts` и `task-labels.ts`.

- [ ] **Review Gate 3.1:** Запустить субтред-ревьюер по AP-011, AP-019, AP-023, AP-045.
  - Критерий прохождения: 10/10 тестов `task-graph-bridge.test.ts` зеленые, дебаунс 50мс проверен, teardown подтвержден, вердикт `VERDICT: PASS`.
- [ ] **Version Bump 3.1:** Повысить версию до **`0.2.34`** в `package.json`, закоммитить:
  `chore(release): bump version to 0.2.34 (Task Graph as PlanSteps with debounce)`.

---

### Phase 4: Subagent Courier & Durable SQLite Binding

#### Task 4.1: UI & Streaming Hardening (`message_end flush` & `child-title`)
- **Primary Source / Evidence:** Track 1 audit (`track-1-diffuzmetall-audit.md`), `/tmp/diffuzmetall-adapter/src/native/child-title.ts`.
- **Touched Files:**
  - Create: `src/runner/child-title.ts` (~35 строк)
  - Modify: `src/runner/bridge/bb-child-event-adapter.ts:104-118`
  - Modify: `src/host/subthread-spawner.ts:25-35`
  - Test: `tests/subagent-title-sanitization.test.ts`
- **AP Gates:** AP-010 (Pure Adapter), AP-019 (<200 lines), AP-028 (Resilient Streaming).

- **ЧТО ДЕЛАТЬ (DO):**
  - [ ] Реализовать `nativeChildTitle(name, role, model)`: санировать control/bidi-символы, ограничить длину полей и суммарную длину до 494 символов.
  - [ ] Использовать `nativeChildTitle` в `subthread-spawner.ts` при генерации заголовка для `bb thread spawn`.
  - [ ] В `bb-child-event-adapter.ts` на событии `message_end` проверять остаток текста в `AssistantEntry` и досылать недостающую дельту.
  - [ ] Написать тест на санитизацию заголовков и досыл текста.

- **ЧЕГО НЕ ДЕЛАТЬ (DO NOT):**
  - ⛔ НЕ превышать лимит заголовка в 500 символов, вызывающий ошибку в БД ядра BB.
  - ⛔ НЕ дублировать уже отправленный текст при вызове `message_end flush` (проверять `startsWith(this.currentText)`).

- [ ] **Review Gate 4.1:** Запустить субтред-ревьюер по AP-010, AP-019, AP-028.
  - Критерий прохождения: Тесты санитизации и стриминга зеленые, вердикт `VERDICT: PASS`.
- [ ] **Version Bump 4.1:** Повысить версию до **`0.2.35`** в `package.json`, закоммитить:
  `chore(release): bump version to 0.2.35 (Title sanitization and message_end flush)`.

---

#### Task 4.2: Subagent Reporter + Courier Delivery Architecture
- **Primary Source / Evidence:** Track 4 specification (`track-4-subagents-persistence.md`), `/tmp/diffuzmetall-adapter/src/protocol/subagents/`.
- **Touched Files:**
  - Create: `src/runner/subagent-docs.ts` (~95 строк, <200)
  - Create: `src/runner/subagent-delivery.ts` (~175 строк, <200)
  - Modify: `src/runner/subagent.ts` (~165 строк, <200)
  - Test: `tests/subagent-courier-delivery.test.ts`
- **AP Gates:** AP-010 (Thin Bridge), AP-019 (<200 lines), AP-026 (ACID Persistence), AP-045 (Debounced Batching).

- **ЧТО ДЕЛАТЬ (DO):**
  - [ ] Создать `SubagentsDoc` (`scope: conversation`, `history: latest`): хранить состояние агентов, `outbox`, `batchNumber`, `sending`, `deliveryHold`.
  - [ ] Реализовать `Reporter Task` (`ownership: { kind: "conversation" }, background: true`): ожидает `submission.wait()`, считывает `AssistantEntry`, пишет отчет в `SubagentsDoc.outbox` и гарантирует наличие `Courier`.
  - [ ] Реализовать `Courier Task`:
    - Фаза `gather`: пауза `50ms` (`await runtime.sleep(now + 50)`) для пакетирования отчетов от параллельных сабагентов.
    - Фаза `send`: отправка батча в родительский тред через `parent.submit({ content, whenBusy: "followUp", requestId })`.
  - [ ] Использовать детерминированный `requestId: "subagent-batch:${task.id}:${batch}"` для предотвращения дублей сообщений.
  - [ ] Написать TDD-тесты: батчинг параллельных сабагентов, доставка в занятого родителя (`whenBusy: followUp`), восстановление состояния при рестарте.

- **ЧЕГО НЕ ДЕЛАТЬ (DO NOT):**
  - ⛔ НЕ блокировать родительский диалог при синхронном ожидании фоновых сабагентов.
  - ⛔ НЕ отправлять отчеты повторно при сбоях (использовать детерминированный `requestId`).
  - ⛔ НЕ объединять `SubagentsDoc` и логику `Courier` в один файл (строго разделять на `subagent-docs.ts` и `subagent-delivery.ts` ради AP-019).
  - ⛔ НЕ использовать monkey-patching ядра BB — отправка идет стандартным `parent.submit()`.

- [ ] **Review Gate 4.2:** Запустить субтред-ревьюер по AP-010, AP-019, AP-026, AP-045.
  - Критерий прохождения: Тесты доставки и восстановления зеленые, все файлы < 200 строк, вердикт `VERDICT: PASS`.
- [ ] **Version Bump 4.2:** Повысить версию до **`0.2.36`** в `package.json`, закоммитить:
  `chore(release): bump version to 0.2.36 (Subagent Reporter + Courier delivery)`.

---

#### Task 4.3: Durable Binding Store (Persistent Thread Mapping in SQLite)
- **Primary Source / Evidence:** Track 4 specification (`track-4-subagents-persistence.md`), `/tmp/diffuzmetall-adapter/src/store/binding-store.ts`.
- **Touched Files:**
  - Create: `src/runner/binding-docs.ts` (~110 строк, <200)
  - Create: `src/host/durable-binding-store.ts` (~140 строк, <250)
  - Modify: `src/host/session.ts` (сокращается до ~195 строк)
  - Modify: `src/host/session-registry.ts`
  - Test: `tests/durable-binding-store.test.ts`
- **AP Gates:** AP-010 (Separation of Concerns), AP-019 (<200 / <250 lines), AP-026 (Persistent Storage).

- **ЧТО ДЕЛАТЬ (DO):**
  - [ ] Создать `BindingDoc` (`scope: conversation`) и `BindingIndexDoc` (`scope: session`) для персистентной связки `bbThreadId <-> conversationId`.
  - [ ] В раннере добавить обработчики RPC `register_binding` (транзакционный коммит в SQLite) и `get_all_bindings`.
  - [ ] В хосте реализовать `DurableBindingManager`: L1 in-memory кэш для микросекундных чтений + RPC-запросы к раннеру на запись.
  - [ ] Реализовать offline fallback через `node:sqlite` в режиме `readOnly: true` для холодного старта хоста до запуска раннера.
  - [ ] Рефакторить `session.ts`: удалить монолитные `Map`, делегировать вызовы в `DurableBindingManager`.
  - [ ] Написать TDD-тесты: сохранение связки, восстановление связок после перезапуска хоста, offline-чтение.

- **ЧЕГО НЕ ДЕЛАТЬ (DO NOT):**
  - ⛔ НЕ писать в `session.sqlite` напрямую из процесса хоста в обход раннера (раннер держит эксклюзивный замок базы; хост пишет ТОЛЬКО через RPC к раннеру).
  - ⛔ НЕ хранить связки тредов исключительно в оперативной памяти `Map`.
  - ⛔ НЕ допускать размер `session.ts` более 250 строк.

- [ ] **Review Gate 4.3:** Запустить субтред-ревьюер по AP-010, AP-019, AP-026.
  - Критерий прохождения: Тесты персистентности и холодного старта зеленые, `session.ts` < 200 строк, вердикт `VERDICT: PASS`.
- [ ] **Version Bump 4.3:** Повысить версию до **`0.2.37`** в `package.json`, закоммитить:
  `chore(release): bump version to 0.2.37 (DurableBindingStore SQLite persistence)`.

---

### Phase 5: Verification, Bundling & Cycle 93 Ledger

#### Task 5.1: Full Verification Suite & Bundle Rebuild
- **Touched Files:**
  - Build: `dist/runner/index.js`, `dist/host.js`, `dist/server.js`
- **AP Gates:** AP-019 (Full Line Audit), AP-029 (Strict Types), AP-071 (Verification Before Claims).

- **ЧТО ДЕЛАТЬ (DO):**
  - [ ] Запустить `npx tsc --noEmit` и убедиться в отсутствии ошибок компиляции.
  - [ ] Запустить полный сьют `npm test` (все 235+ тестов обязаны проходить, 0 fail, 0 skip).
  - [ ] Запустить аудит длины строк по всем файлам `src/runner/` (<200) и `src/host/` (<250).
  - [ ] Выполнить чистую сборку бандлов `npm run build`.
  - [ ] Запустить `npm run doctor` и зафиксировать вывод.

- **ЧЕГО НЕ ДЕЛАТЬ (DO NOT):**
  - ⛔ НЕ заявлять об успехе до получения реального вывода терминала (AP-071).
  - ⛔ НЕ игнорировать ни единого предупреждения `npm test` или компилятора.

- [ ] **Review Gate 5.1:** Запустить итоговый субтред-ревьюер на весь diff Cycle 93 по чек-листу `arch-rules-implementation-review`.
  - Критерий прохождения: 100% соблюдение AP-правил, отсутствие регрессий, вердикт `VERDICT: PASS`.
- [ ] **Version Bump 5.1:** Повысить версию до **`0.2.38`** в `package.json`, закоммитить:
  `chore(release): bump version to 0.2.38 (Full verification and clean bundles)`.

---

#### Task 5.2: Release, Ledger & Memory Update
- **Touched Files:**
  - Modify: `package.json` (финальный релизный маркер)
  - Modify: `docs/arch-improvement/ledger.md`
  - Modify: `CHANGELOG.md`
- **AP Gates:** AP-010 (Traceability), Gate 7 (Write-back).

- **ЧТО ДЕЛАТЬ (DO):**
  - [ ] Оформить подробный раздел `Cycle 93` в `docs/arch-improvement/ledger.md`.
  - [ ] Обновить `CHANGELOG.md` с описанием всех нововведений и закрытых PR.
  - [ ] Сохранить ключевые уроки цикла в память GBrain.

- [ ] **Review Gate 5.2:** Проверка полноты артефактов релиза. Вердикт `VERDICT: PASS`.
