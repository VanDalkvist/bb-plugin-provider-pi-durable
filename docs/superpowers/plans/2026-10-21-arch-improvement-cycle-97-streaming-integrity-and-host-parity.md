# Cycle 97: Upstream Streaming Integrity, Bundled Version Resolution & SDK Subagent Context Preservation (AP-010, AP-013, AP-019, AP-026, AP-028)

> **For agentic workers:** Arch Improvement Loop Execution. Every slice executes strictly via `arch-improvement-loop` state machine.
> - **Implementers [S8]:** Load and execute `~/Projects/arch-improvement-skills/skills/arch-improvement-fix/SKILL.md` and `~/Projects/.agents/skills/superpowers/test-driven-development/SKILL.md`.
> - **Reviewers [S9]:** Load and execute `~/Projects/arch-rules-skills/skills/arch-rules-implementation-review/SKILL.md` and `~/Projects/arch-improvement-skills/skills/arch-improvement-review/SKILL.md` against `~/Projects/arch-rules/arch-rules.md`.
> - **Orchestrator [S10]:** Verifies `VERDICT: PASS`, records ledger, increments version `0.2.x + 1` in `package.json`, commits and pushes to `main`.
> - Do NOT duplicate skill instructions in prompts — agents read canonical skills directly from disk.

**Goal:** Систематически устранить накопленные дефекты интеграции с апстрим-рантаймом `@earendil-works/pi-durable` и хостом Beyond Boundaries: потерю начального фрагмента текста при возобновлении стриминга после тулов (Issue #10), ложный статус обновления `0.0.0-unknown` в развернутом хост-бандле (PR #15 / Issue #18), и потерю собственных дескрипторов контекста инструментов при неглубоком клонировании (Issue #21).

## Architecture Context & Invariants
- **AP-010 (Separation of Concerns / Ports & Adapters):** Хост отвечает строго за трансляцию протокола BB, раннер — за адаптацию шины `@earendil-works/pi-durable`.
- **AP-013 / AP-034 (Single Side-Effect Ownership & Data Integrity):** Потоки событий и буферы текста строго изолированы, данные генерации не теряются на границах блоков.
- **AP-019 (Modularity Budgets):** Все файлы в `src/runner/` строго < 200 строк, все файлы в `src/host/` строго < 250 строк.
- **AP-026 (Contract Parity & ACID):** Дельты ходов строго соответствуют контракту `threadDeltaSchema`.
- **AP-028 (Resilient Streaming):** Любой текстовый контент, сгенерированный моделью (включая начальный `text_start` и `thinking_start`), непрерывно стримится в UI.

---

## Planned Slices

### Slice 97.1 (P1): Resilient Text & Thinking Streaming (`text_start` / `thinking_start` Handling, Issue #10)
- **Primary Source / Evidence:** Анализ `packages/durable/src/harness/events.ts:430` и `src/runner/bridge/bb-event-adapter.ts:104`. При сплите блоков после исполнения тулов Chord генерирует `{ type: "text_start", block: { type: "text", text: string } }`. `BBEventAdapter` и `BBChildEventAdapter` фильтруют только `change.type === "text_delta"`, из-за чего первый чанк текста отбрасывается во время стриминга и появляется только в `item.textClose`. Кроме того, `this.currentText` не очищался на `message_end` в `bb-event-adapter.ts`.
- **Touched Files:**
  - Modify: `src/runner/bridge/bb-event-adapter.ts` (обработка `text_start`, `thinking_start`, очистка `currentText` на `message_end`, лимит < 200 строк)
  - Modify: `src/runner/bridge/bb-child-event-adapter.ts` (обработка `text_start`, `thinking_start`, лимит < 200 строк)
  - Test: `tests/bb-event-adapter.test.ts`
- **Applicable AP Gates:** AP-010, AP-019 (<200 lines), AP-026, AP-028.
- [ ] **[S8: Execute Slice]:**
  - TDD тест в `tests/bb-event-adapter.test.ts`: эмит `message_update` с `text_start` (содержащим начальный текст) немедленно транслируется в `assistantMessageEvent` (`text_delta`) и добавляется в `currentText`.
  - Реализация обработки `text_start` и `thinking_start` с непустым текстом в `BBEventAdapter` и `BBChildEventAdapter`.
  - Очистка `this.currentText = ""` и `this.currentThinking = ""` на `message_end` в `BBEventAdapter`.
  - Все тесты зеленые, `npx tsc --noEmit` чист.
- [ ] **[S9: Verify Gate]:** Двухконтурный гейт S9 (S9a Architecture + S9b Product) с терминальными receipts.
- [ ] **[S10: Version Bump]:** Повысить версию до **`0.2.42`** в `package.json`, закоммитить и запушить в `main`.

---

### Slice 97.2 (P1): Bundled Plugin Version Resolution in Deployed Host Artifacts (PR #15 / Issue #18)
- **Primary Source / Evidence:** Анализ `host.mjs` в `~/.bb/plugin-host-artifacts/<pluginId>/<digest>/host.mjs`. Хост-бандл разворачивается в изолированную директорию без `package.json`. Вызов `resolvePluginVersion()` падает в fallback `"0.0.0-unknown"`, из-за чего BB считает плагин устаревшим и показывает вечное предупреждение.
- **Touched Files:**
  - Modify: `src/host/installation-manager.ts` (запекание `BUNDLED_PLUGIN_VERSION` из `package.json` на этапе esbuild сборки, лимит < 250 строк)
  - Modify: `tsconfig.json` (`"resolveJsonModule": true`)
  - Modify: `tests/startup-readiness.test.ts` (таймаут `CATALOGUE_READY_BUDGET_MS = 45_000` для тяжелых машин)
  - Test: `tests/provider-installation.test.ts` (тест deployed-layout без соседнего `package.json`)
- **Applicable AP Gates:** AP-010, AP-019 (<250 lines), AP-027.
- [ ] **[S8: Execute Slice]:**
  - Тест в `tests/provider-installation.test.ts`: резолв версии из изолированного хост-артефакта возвращает валидный semver из манифеста вместо `0.0.0-unknown`.
  - Реализация `BUNDLED_PLUGIN_VERSION` в `installation-manager.ts`.
  - `npm run build`, `npm test` и `npx tsc --noEmit` зеленые.
- [ ] **[S9: Verify Gate]:** Двухконтурный гейт S9 (S9a Architecture + S9b Product) с терминальными receipts.
- [ ] **[S10: Version Bump]:** Повысить версию до **`0.2.43`** в `package.json`, закоммитить и запушить в `main`.

---

### Slice 97.3 (P2): Context Own Property Descriptors for Extension Tools (Issue #21)
- **Primary Source / Evidence:** Анализ `packages/coding-agent/src/core/extensions/runner.ts:968` и Issue #21. При поверхностном копировании `{ ...ctx }` в тулах (например, `pi-subagents` `0.77.0`) несобственные унаследованные геттеры прототипа отбрасываются.
- **Touched Files:**
  - Modify: `src/runner/tool-adapter.ts` (гарантия сохранения own property descriptors при передаче контекста в `toolDef.execute`, лимит < 200 строк)
  - Test: `tests/tool-context-preservation.test.ts`
- **Applicable AP Gates:** AP-010, AP-019 (<200 lines), AP-029.
- [ ] **[S8: Execute Slice]:**
  - Тест в `tests/tool-context-preservation.test.ts`: проверка, что объектный спред `{ ...ctx }` сохраняет доступ к `modelRegistry`, `sessionManager` и `ui`.
  - Реализация сохранения собственных дескрипторов.
  - Все тесты зеленые, `npx tsc --noEmit` чист.
- [ ] **[S9: Verify Gate]:** Двухконтурный гейт S9 (S9a Architecture + S9b Product) с терминальными receipts.
- [ ] **[S10: Version Bump]:** Повысить версию до **`0.2.44`** в `package.json`, закоммитить и запушить в `main`.

---

### Housekeeping: Закрытие решенных Issues на GitHub
- [ ] Закрыть Issue #17 на GitHub с указанием коммита `cbfd016` (PR #16).
