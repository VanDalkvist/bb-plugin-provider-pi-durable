# Cycle 96: Subagent Product Scenarios & Watchdog Hardening (AP-010, AP-013, AP-019, AP-026, AP-028, AP-034)

> **For agentic workers:** Arch Improvement Loop Execution. Every slice executes strictly via `arch-improvement-loop` state machine.
> - **Implementers [S8]:** Load and execute `~/Projects/arch-improvement-skills/skills/arch-improvement-fix/SKILL.md` and `~/Projects/.agents/skills/superpowers/test-driven-development/SKILL.md`.
> - **Reviewers [S9]:** Load and execute `~/Projects/arch-rules-skills/skills/arch-rules-implementation-review/SKILL.md` and `~/Projects/arch-improvement-skills/skills/arch-improvement-review/SKILL.md` against `~/Projects/arch-rules/arch-rules.md`.
> - **Orchestrator [S10]:** Verifies `VERDICT: PASS`, records ledger, increments version `0.2.x + 1` in `package.json`, commits and pushes to `main`.
> - Do NOT duplicate skill instructions in prompts — agents read canonical skills directly from disk.

**Goal:** Систематически закрыть продуктовые сценарии использования нативных сабагентов Beyond Boundaries: прерывание дочернего треда (`thread/stop`) с изоляцией от родителя, сквозная гонка раннего завершения (Early Agent End Race), конкурентность и изоляция параллельных сабагентов, стриминг Extended Thinking в теневом треде, и цепочки инструментов с diff-превью.

## Architecture Context & Invariants
- **AP-010 (Separation of Concerns / Ports & Adapters):** Доменная логика рантайма `@earendil-works/pi-durable` и FSM-задачи изолированы в раннере; хост (`src/host/`) отвечает строго за трансляцию протокола Provider Bridge и оркестрацию тредов в BB.
- **AP-013 / AP-034 (Single Side-Effect Ownership):** Ровно один обработчик выполняет остановку/аборт конкретного `conversationId` (`handleThreadStop`).
- **AP-019 (Modularity Budgets):** Все файлы в `src/runner/` строго < 200 строк, все файлы в `src/host/` строго < 250 строк.
- **AP-026 (ACID & Persistence):** Связки тредов сохраняются в SQLite (`DurableBindingStore`), а накопленный текст сохраняется в `SubagentMirrorManager`.
- **AP-028 (Resilient Streaming):** Любой ход в дочернем треде обязан получать `turn.open` сразу при старте и закрываться через `turn.boundary`, исключая 120s watchdog таймауты и зависания.

---

## Planned Slices (TDD Checkbox Steps)

### Slice 6.1 (P0): Targeted Child Interruption & Stop Isolation (AP-013, AP-034)
- **Primary Source / Evidence:** Анализ `handleThreadStop` (`src/host/bridge-router.ts:213`): при `intent === "interrupt"` на дочернем треде `parseProviderThreadId` возвращает `conversationId = undefined`, из-за чего `session.abort(undefined)` прерывает родительскую сессию (`conv 1`) вместо дочернего сабагента (`conv X`).
- **Touched Files:**
  - Modify: `src/host/bridge-router.ts` (проверка `session.getConversationIdForThread(params.threadId)` в `handleThreadStop` и `handleTurnSteer`, лимит < 250 строк)
  - Modify: `src/host/session.ts` (таргетированный эмит `session.ended` и `turn.boundary: interrupted` конкретному дочернему треду, лимит < 250 строк)
  - Test: `tests/subagent-stop-interruption.test.ts`
- **Applicable AP Gates:** AP-010 (Thin Bridge), AP-013/034 (Single Side-Effect Ownership), AP-019 (<250 lines), AP-026 (Isolation).
- [x] **[S8: Execute Slice]:**
  - TDD тест в `tests/subagent-stop-interruption.test.ts`: вызов `handleThreadStop` для дочернего треда прерывает строго сабагента (`conv X`), родительская сессия (`conv 1`) продолжает выполняться без абортов.
  - Реализация таргетированного резолва conversationId в `handleThreadStop` и `handleTurnSteer`.
  - Все тесты зеленые, `npx tsc --noEmit` чист.
- [x] **[S9: Verify Gate]:** Двухконтурный гейт S9 (S9a Architecture + S9b Product) с терминальными receipts.
- [x] **[S10: Version Bump]:** Повысить версию до **`0.2.41`** в `package.json`, закоммитить и запушить в `main`.

---

### Slice 6.2 (P0): Early Completion Race & Watchdog Boundary Guarantee (AP-026, AP-028)
- **Primary Source / Evidence:** Сабагент завершается молниеносно (20–50 мс) до того, как BB Server завершил `bb thread spawn` и прислал `turn/start`.
- **Touched Files:**
  - Test: `tests/subagent-early-completion-race.test.ts`
- **Applicable AP Gates:** AP-010 (Thin Bridge), AP-019 (<200 / <250 lines), AP-026 (ACID & Event Buffer), AP-028 (Resilient Streaming).
- [x] **[S8: Execute Slice]:**
  - Написать сквозной тест: `handleRunnerEvent(agent_end)` ➔ `SubagentMirrorManager.markCompleted` ➔ отложенный `handleTurnStart`.
  - Подтвердить детерминированный эмит: `turn.open` (watchdog) ➔ `item.textDelta`/`item.textClose` (полный накопленный текст) ➔ `turn.boundary: completed`.
  - Подтвердить очистку памяти через `consumeCompleted`.
- [x] **[S9: Verify Gate]:** Двухконтурный гейт S9 с терминальными receipts.
- [x] **[S10: Version Bump]:** Фиксация в `package.json` и коммит.

---

### Slice 6.3 (P1): Parallel Subagents Concurrency & Event Buffer Isolation (AP-010, AP-045)
- **Primary Source / Evidence:** Одновременный запуск двух или трёх параллельных сабагентов (`conv 101`, `conv 102`) в разных теневых тредах (`thr_child_1`, `thr_child_2`).
- **Touched Files:**
  - Test: `tests/subagent-parallel-concurrency.test.ts`
- **Applicable AP Gates:** AP-010 (Pure Adapter), AP-019 (<200 / <250 lines), AP-045 (Debounced Batching).
- [ ] **[S8: Execute Slice]:**
  - Написать тест параллельного стриминга: одновременный поток runner events для двух разных conversationId.
  - Подтвердить строгую изоляцию буферов в `SubagentMirrorManager` (`eventBuffers`, `outputTexts`) по `conversationId`.
  - Подтвердить, что Courier батчит одновременные завершения в 50ms окне без конфликтов и дефекта Silent Void.
- [ ] **[S9: Verify Gate]:** Двухконтурный гейт S9 с терминальными receipts.
- [ ] **[S10: Version Bump]:** Повысить версию до **`0.2.42`** в `package.json`, закоммитить и запушить в `main`.

---

### Slice 6.4 (P1): Extended Thinking & Multi-Tool Chain with Diff Preview (AP-019, AP-028)
- **Primary Source / Evidence:** Сабагент генерирует Extended Thinking (`thinking_delta`) и цепочку инструментов (`bash` ➔ `read` ➔ `write` ➔ `edit`).
- **Touched Files:**
  - Test: `tests/subagent-thinking-and-multitool-stream.test.ts`
- **Applicable AP Gates:** AP-019 (<200 / <250 lines), AP-028 (Resilient Streaming), AP-029 (Strict Types).
- [ ] **[S8: Execute Slice]:**
  - Написать тест стриминга Extended Thinking в теневой тред: проверка открытия reasoning-канала (иконка Brain), дельт текста и `item.textClose` без `parentRef`.
  - Написать проверку цепочки инструментов: `write` и `edit` генерируют валидные `fileChange` дельты с git diff.
  - Написать проверку tool execution error (`isError: true`): карточка закрывается статусом `failed`, тред не виснет.
- [ ] **[S9: Verify Gate]:** Двухконтурный гейт S9 с терминальными receipts.
- [ ] **[S10: Version Bump]:** Фиксация в `package.json` и коммит.

---

### Slice 6.5 (P2): Multi-Turn Interactive Conversation Continuation (AP-026, AP-029)
- **Primary Source / Evidence:** Пользователь продолжает диалог с сабагентом в дочернем треде (Turn 1 completed ➔ Turn 2 user prompt ➔ Turn 2 completed ➔ Turn 3 steer).
- **Touched Files:**
  - Test: `tests/subagent-interactive-continuation.test.ts`
- **Applicable AP Gates:** AP-010 (Pure Adapter), AP-026 (Persistence & Context), AP-029 (Strict Types).
- [ ] **[S8: Execute Slice]:**
  - Написать тест непрерывного диалога: Turn 1 ➔ Turn 2 (вопрос пользователя и ответ сабагента) ➔ Turn 3 (руление через `turn/steer`).
  - Подтвердить, что `handleTurnStart` и `handleTurnSteer` стабильно адресуют `conversationId` дочерней беседы, сохраняя контекст диалога в SQLite.
- [ ] **[S9: Verify Gate]:** Двухконтурный гейт S9 с терминальными receipts.
- [ ] **[S10: Version Bump]:** Повысить версию до **`0.2.43`** в `package.json`, закоммитить и запушить в `main`.
