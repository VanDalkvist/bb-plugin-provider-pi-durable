# Cycle 93: Upstream Pi 1.3 Parity, Task Graph PlanSteps, Inbound PRs & Resilient Subagents Implementation Plan

> **For agentic workers:** Arch Improvement Loop Execution. Every slice executes strictly via `arch-improvement-loop` state machine.
> - **Implementers [S8]:** Load and execute `~/Projects/arch-improvement-skills/skills/arch-improvement-fix/SKILL.md` and `~/Projects/.agents/skills/superpowers/test-driven-development/SKILL.md`.
> - **Reviewers [S9]:** Load and execute `~/Projects/arch-rules-skills/skills/arch-rules-implementation-review/SKILL.md` and `~/Projects/arch-improvement-skills/skills/arch-improvement-review/SKILL.md` against `~/Projects/arch-rules/arch-rules.md`.
> - **Orchestrator [S10]:** Verifies `VERDICT: PASS`, records ledger, increments version `0.2.x + 1` in `package.json`, commits and pushes to `main`.
> - Do NOT duplicate skill instructions in prompts — agents read canonical skills directly from disk.

**Goal:** Систематически и детерминированно модернизировать `bb-plugin-provider-pi-durable`: интегрировать проверенные пулл-реквесты (#20, #22, #16), обновить ядро до upstream `@earendil-works/pi-durable@1.3.0` с удалением устаревших костылей, и внедрить лучшие архитектурные решения по надежной фоновой доставке сабагентов (Reporter + Courier) и персистентному хранению связок тредов в SQLite (Durable Binding Store) без единой правки ядра BB IDE.

**Architecture:** Архитектура базируется на фундаментальном инварианте **The Four Territories & Thin Bridge** (GoF Adapter). BB IDE выступает клиентом UI и хостом (`@get-bb/plugin-sdk`), раннер плагина управляет транзакционным рантаймом `@earendil-works/pi-durable`, а расширения (`subagent`, `tasks`, `bindings`) строятся строго поверх публичных FSM-задач (`defineTask`), документов (`defineDoc`) и транзакций SQLite. Все модули строго подчиняются лимитам AP-019 (<200 строк в `src/runner/`, <250 строк в `src/host/`).

**Tech Stack:** TypeScript 5.7+, Node.js >= 22.19.0 (built-in `node:sqlite`), `@earendil-works/pi-durable@1.3.0`, `@earendil-works/chord@1.3.0`, `@earendil-works/pi-coding-agent@1.3.0`, `@earendil-works/pi-ai@1.3.0`, `@get-bb/plugin-sdk@0.6.15`.

---

## 1. Arch Improvement Loop State Machine & Subagent Protocol

Исполнение плана организовано строго по конечному автомату `arch-improvement-loop` (S0–S12) в единой нативной среде Pi Durable:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        ARCH IMPROVEMENT LOOP                           │
│                                                                        │
│  [S8: Execute Fix Slice]  ──(worker subagent)──►  Commit / Red-Green   │
│            │                                            │              │
│            ▼                                            ▼              │
│  [S9: Verify Gate]        ──(review subagent)──►  VERDICT: PASS/FAIL   │
│            │                                            │              │
│            ▼ (if PASS)                                  ▼              │
│  [S10: Step Version Bump] ──(orchestrator)   ──►  0.2.x + 1 & Push     │
│            │                                                           │
│            ▼ (repeat for next slice until S11/S12)                     │
└────────────────────────────────────────────────────────────────────────┘
```

### Правила взаимодействия агентов:
1. **Оркестратор (Lead Agent):**
   - Управляет переходами состояний S8 ➔ S9 ➔ S10.
   - Делегирует исполнение через нативный инструмент `subagent` (`tools.subagent({ task, background: false })`).
   - Не пишет код за воркеров и не дублирует тексты скиллов в промптах. Передает ссылку на задачу плана и пути к каноничным скиллам.
   - Слияние PR (#20, #22, #16) производит через честный `git merge --no-ff`, сохраняя коммиты и авторство контрибьюторов (Diffuzmetall, marmoza).
2. **Воркер реализации [S8: Execute Fix Slice]:**
   - **Обязан прочитать и следовать скиллам:**
     - `~/Projects/arch-improvement-skills/skills/arch-improvement-fix/SKILL.md`
     - `~/Projects/.agents/skills/superpowers/test-driven-development/SKILL.md`
   - Реализует минимальный boundary-preserving патч.
   - Соблюдает бюджеты строк AP-019 (<200 в `src/runner/`, <250 в `src/host/`).
   - Подтверждает результат детерминированными тестами (`npm test`) и тайпчеком (`npx tsc --noEmit`).
3. **Независимый ревьюер [S9: Verify Gate]:**
   - **Обязан прочитать и следовать скиллам:**
     - `~/Projects/arch-rules-skills/skills/arch-rules-implementation-review/SKILL.md`
     - `~/Projects/arch-improvement-skills/skills/arch-improvement-review/SKILL.md`
     - `~/Projects/arch-rules/arch-rules.md`
   - Проверяет diff коммита строго по правилам AP-010 ... AP-071.
   - Формирует отчет по каноничному формату: Findings (`[P1]...`), Architecture verification (`Passed: AP-###`, `Residual risk`), и выносит итоговый вердикт: `VERDICT: PASS` или `VERDICT: FAIL`.
4. **Пошаговый бамп версий [S10]:**
   - Каждая завершенная и принятая ревьюером фича инкрементирует версию `0.2.x + 1` в `package.json` и пушится в `main`.

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

## 3. Implementation Phases & Arch Loop Slices

---

### Phase 1: Host Stability Foundation (PR #20 ➔ PR #22)

#### Slice 1.1: Merge PR #20 (Deterministic Runner Resolution)
- **Primary Source / Evidence:** PR #20 (`fix/runner-resolution`), commits `3aa5566`, `d50da50`. Решает issue #18.
- **Touched Files:** `src/host/runner-lookup.ts`, `src/host/paths.ts`, `tests/runner-discovery.test.ts`, `tests/startup-readiness.test.ts`.
- **Applicable AP Gates:** AP-010 (Decoupled Lookup), AP-019 (File size < 250), AP-028 (No swallowed errors).
- [x] **[S8: Execute Slice]:** Честный `git merge --no-ff pr-20` с сохранением оригинальных коммитов Diffuzmetall.
- [x] **[S9: Verify Gate]:** Ревью по `arch-rules-implementation-review`. Вердикт `VERDICT: PASS` (211/211 тестов).
- [x] **[S10: Version Bump]:** Бамп до **`0.2.31`**, коммит `1173ab6`, пуш в `main`.

---

#### Slice 1.2: Merge PR #22 (Preserve BB System Instructions)
- **Primary Source / Evidence:** PR #22 (`fix/bb-context-parity`), commit `3155b35`.
- **Touched Files:** `src/host/runner-prompts.ts`, `src/host/runner-process.ts`, `src/host/session-registry.ts`, `src/host/session.ts`, `tests/bb-instructions-parity.test.ts`.
- **Applicable AP Gates:** AP-010 (Thin Bridge), AP-013 (Process Isolation), AP-019 (<250 lines), AP-023 (Resource Cleanup).
- [x] **[S8: Execute Slice]:** Честный `git merge --no-ff pr-22` с сохранением оригинального коммита marmoza.
- [x] **[S9: Verify Gate]:** Ревью по `arch-rules-implementation-review`. Права `0o600/0o700`, очистка файлов, вердикт `VERDICT: PASS` (216/216 тестов).
- [x] **[S10: Version Bump]:** Бамп до **`0.2.32`**, коммит `80ffe72`, пуш в `main`.

---

### Phase 2: Upstream Pi 1.3.0 Parity & Workaround Removal

#### Slice 2.1: Upgrade Dependencies to `@earendil-works/*@1.3.0` & Prune Workarounds
- **Primary Source / Evidence:** Upstream tags and packages in `/Users/vanya/Projects/pi` (`v1.3.0`, commits `71023aec1`, `f7e3cb543`, `5ab7fe74c`). Спецификация: `docs/arch-improvement/cycle-93/track-2-upstream-pi-1.3.md`.
- **Touched Files:** `package.json`, `package-lock.json`, `src/runner/bridge/tool-result-extractor.ts`, `src/runner/tool-adapter.ts`, `tests/anthropic-image-error.test.ts`, `tests/package-integrity.test.ts`.
- **Applicable AP Gates:** AP-010 (Thin Bridge), AP-026 (State Persistence), AP-029 (Zero Type Casts).
- [x] **[S8: Execute Slice]:** Выполнено воркером (коммит `be02f12`): пакеты обновлены до `1.3.0`, `sanitizeToolResultForAnthropic` удален, `npm test` 214/214 pass, `npx tsc` clean.
- [x] **[S9: Verify Gate]:** Ревью по `arch-rules-implementation-review`. Вердикт `VERDICT: PASS`.
- [x] **[S10: Version Bump]:** Повысить версию до **`0.2.33`** в `package.json`, закоммитить и запушить в `main`.

---

### Phase 3: Live Task Graph PlanSteps (PR #16 + Polish)

#### Slice 3.1: Integrate Live Task Graph with Debounce and Teardown
- **Primary Source / Evidence:** PR #16 (`feat/durable-task-graph`), commit `ece06ec`. Спецификация: `docs/arch-improvement/cycle-93/track-3-inbound-prs-audit.md`.
- **Touched Files:**
  - Create: `src/runner/task-labels.ts` (78 строк)
  - Create: `src/runner/task-graph-bridge.ts` (~80 строк)
  - Modify: `src/host/delta-translator.ts:130-145`
  - Modify: `src/runner/bridge/contracts.ts`
  - Modify: `src/runner/index.ts`
  - Test: `tests/task-graph-bridge.test.ts`
- **Applicable AP Gates:** AP-011 (Lifecycle Cleanup), AP-019 (<200 lines), AP-023 (Zero Leaks), AP-045 (Coalesced Events).
- [ ] **[S8: Execute Slice]:**
  - Выполнить честный `git merge --no-ff pr-16` (сохраняя коммиты Diffuzmetall).
  - Воркер реализует дебаунс 50 мс для снапшотов `tasks_snapshot` в `task-graph-bridge.ts`, возвращает `unsubscribe()` и очищает подписку при teardown.
  - В `delta-translator.ts` транслирует `tasks_snapshot` в BB контракт `planSteps` через `experimental_planStepsPresentation`.
  - Убедиться, что `dist/` не коммитится, и добавить тесты на дебаунс.
- [ ] **[S9: Verify Gate]:** Ревью по `arch-rules-implementation-review`. Проверка отсутствия утечек подписок (AP-011, AP-023), дебаунса 50мс (AP-045), лимитов AP-019.
- [ ] **[S10: Version Bump]:** Повысить версию до **`0.2.34`** в `package.json`, закоммитить и запушить в `main`.

---

### Phase 4: Subagent Courier & Durable SQLite Binding

#### Slice 4.1: UI & Streaming Hardening (`message_end flush` & `child-title`)
- **Primary Source / Evidence:** Track 1 audit (`track-1-diffuzmetall-audit.md`), `/tmp/diffuzmetall-adapter/src/native/child-title.ts`.
- **Touched Files:**
  - Create: `src/runner/child-title.ts` (~35 строк)
  - Modify: `src/runner/bridge/bb-child-event-adapter.ts:104-118`
  - Modify: `src/host/subthread-spawner.ts:25-35`
  - Test: `tests/subagent-title-sanitization.test.ts`
- **Applicable AP Gates:** AP-010 (Pure Adapter), AP-019 (<200 lines), AP-028 (Resilient Streaming).
- [ ] **[S8: Execute Slice]:** Воркер реализует `nativeChildTitle` (санитизация control/bidi символов, лимит 494 символа) и `message_end flush` (досыл недостающей текстовой дельты при завершении сообщения без дублирования). TDD-тесты.
- [ ] **[S9: Verify Gate]:** Ревью по `arch-rules-implementation-review`.
- [ ] **[S10: Version Bump]:** Повысить версию до **`0.2.35`** в `package.json`, закоммитить и запушить в `main`.

---

#### Slice 4.2: Subagent Reporter + Courier Delivery Architecture
- **Primary Source / Evidence:** Track 4 specification (`track-4-subagents-persistence.md`), `/tmp/diffuzmetall-adapter/src/protocol/subagents/`.
- **Touched Files:**
  - Create: `src/runner/subagent-docs.ts` (~95 строк, <200)
  - Create: `src/runner/subagent-delivery.ts` (~175 строк, <200)
  - Modify: `src/runner/subagent.ts` (~165 строк, <200)
  - Test: `tests/subagent-courier-delivery.test.ts`
- **Applicable AP Gates:** AP-010 (Thin Bridge), AP-019 (<200 lines), AP-026 (ACID Persistence), AP-045 (Debounced Batching).
- [ ] **[S8: Execute Slice]:**
  - Реализовать `SubagentsDoc` (`scope: conversation`, `history: latest`).
  - Реализовать `Reporter Task` (`ownership: { kind: "conversation" }, background: true`): ожидает `submission.wait()`, считывает отчет, кладет в `outbox`, гарантирует `Courier`.
  - Реализовать `Courier Task` (50ms gather debounce, `parent.submit({ whenBusy: "followUp", requestId })` с детерминированным `requestId`).
  - TDD-тесты: параллельный батчинг, доставка в занятого родителя, восстановление при рестарте.
- [ ] **[S9: Verify Gate]:** Ревью по `arch-rules-implementation-review`.
- [ ] **[S10: Version Bump]:** Повысить версию до **`0.2.36`** в `package.json`, закоммитить и запушить в `main`.

---

#### Slice 4.3: Durable Binding Store (Persistent Thread Mapping in SQLite)
- **Primary Source / Evidence:** Track 4 specification (`track-4-subagents-persistence.md`), `/tmp/diffuzmetall-adapter/src/store/binding-store.ts`.
- **Touched Files:**
  - Create: `src/runner/binding-docs.ts` (~110 строк, <200)
  - Create: `src/host/durable-binding-store.ts` (~140 строк, <250)
  - Modify: `src/host/session.ts` (сокращается до ~195 строк)
  - Modify: `src/host/session-registry.ts`
  - Test: `tests/durable-binding-store.test.ts`
- **Applicable AP Gates:** AP-010 (Separation of Concerns), AP-019 (<200 / <250 lines), AP-026 (Persistent Storage).
- [ ] **[S8: Execute Slice]:**
  - Создать `BindingDoc` (`scope: conversation`) и `BindingIndexDoc` (`scope: session`).
  - В раннере добавить RPC `register_binding` и `get_all_bindings`.
  - В хосте реализовать `DurableBindingManager`: L1 cache + RPC запись + offline fallback `node:sqlite` (`readOnly: true`).
  - Рефакторинг `session.ts` (<200 строк). TDD-тесты холодного старта и восстановления.
- [ ] **[S9: Verify Gate]:** Ревью по `arch-rules-implementation-review`.
- [ ] **[S10: Version Bump]:** Повысить версию до **`0.2.37`** в `package.json`, закоммитить и запушить в `main`.

---

### Phase 5: Verification, Bundling & Cycle 93 Ledger

#### Slice 5.1: Full Verification Suite & Bundle Rebuild
- **Touched Files:** Build: `dist/runner/index.js`, `dist/host.js`, `dist/server.js`.
- **Applicable AP Gates:** AP-019 (Full Line Audit), AP-029 (Strict Types), AP-071 (Verification Before Claims).
- [ ] **[S8: Execute Slice]:** `npx tsc --noEmit`, `npm test` (все тесты pass), аудит AP-019, чистый билд `npm run build`, `npm run doctor`.
- [ ] **[S9: Verify Gate]:** Итоговый сквозной ревьюер по `arch-rules-implementation-review` на весь цикл.
- [ ] **[S10: Version Bump]:** Повысить версию до **`0.2.38`** в `package.json`, закоммитить и запушить в `main`.

---

#### Slice 5.2: Release, Ledger & Memory Update [S10–S12]
- **Touched Files:** `docs/arch-improvement/ledger.md`, `CHANGELOG.md`.
- **Applicable AP Gates:** AP-010 (Traceability), Gate 7 (Write-back).
- [ ] **[S10: Ledger Update]:** Оформить раздел `Cycle 93` в `docs/arch-improvement/ledger.md` и обновить `CHANGELOG.md`.
- [ ] **[S11: Learn Gate]:** Зафиксировать выученные архитектурные уроки в GBrain через `remember`.
- [ ] **[S12: Stop]:** Финальный релизный отчет и статус завершения Cycle 93.
