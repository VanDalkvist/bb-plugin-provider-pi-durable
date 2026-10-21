# Cycle 98: Multimodal Image Attachments Pipeline (Issue #11, AP-010, AP-013, AP-019, AP-026, AP-028)

> **For agentic workers:** Arch Improvement Loop Execution. Every slice executes strictly via `arch-improvement-loop` state machine.
> - **Implementers [S8]:** Load and execute `~/Projects/arch-improvement-skills/skills/arch-improvement-fix/SKILL.md` and `~/Projects/.agents/skills/superpowers/test-driven-development/SKILL.md`.
> - **Reviewers [S9]:** Load and execute `~/Projects/arch-rules-skills/skills/arch-rules-implementation-review/SKILL.md` (S9a Architecture) and `~/Projects/arch-improvement-skills/skills/arch-improvement-product-review/SKILL.md` (S9b Product).
> - **Orchestrator [S10]:** Verifies `VERDICT: PASS` from both circuits, records ledger, increments version `0.2.x + 1` in `package.json`, commits and pushes to `main`.
> - Do NOT duplicate skill instructions in prompts — agents read canonical skills directly from disk.

**Goal:** Реализовать сквозной пайплайн передачи изображений (скриншоты, файлы, вставки из буфера) из треда Beyond Boundaries IDE в рантайм `@earendil-works/pi-durable` (Issue #11): расширить схему пользовательского ввода, реализовать резолвер `localImage` / `image` в base64 `ImageContent`, поддержать мультимодальный `UserInput` через мост хост-раннер и устранить ошибку `-32602 Missing input text` при отправке изображения без текста.

## Architecture Context & Invariants
- **AP-010 (Separation of Concerns / Ports & Adapters):** Хост отвечает за валидацию ввода BB и чтение локальных файлов вложения в base64; раннер принимает чистый `UserInput` (`string | (TextContent | ImageContent)[]`).
- **AP-013 / AP-034 (Single Side-Effect Ownership & Data Integrity):** Вложенные изображения пользователя не теряются и не повреждаются при сериализации через RPC-мост.
- **AP-019 (Modularity Budgets):** Все файлы в `src/runner/` строго < 200 строк, все файлы в `src/host/` строго < 250 строк (`bridge-router.ts` сейчас 241 строка — резолвер картинок выносится в `prompt-input.ts`).
- **AP-026 (Contract Parity & Strict Schemas):** Схема ввода расширяется строго по типам `@get-bb/plugin-sdk/provider-bridge` (`threadEventUserContentSchema`).
- **AP-028 (Test Determinism):** Все сценарии (текст+картинка, только картинка, невалидный путь, нераспознанный MIME) покрываются детерминированными TDD-тестами без внешних сетевых зависимостей.

---

## Planned Slices

### Slice 98.1 (P1): Multimodal Input Schema & Local Image Resolver (`src/host/types.ts` & `src/host/prompt-input.ts`)
- **Primary Source / Evidence:** В `@get-bb/plugin-sdk/provider-bridge` пользовательский ввод содержит `text`, `localImage` (`path`), `image` (`url`), `localFile` (`path`). В `src/host/prompt-input.ts` `extractInputText` отбрасывал всё кроме `text`.
- **Touched Files:**
  - Modify: `src/host/types.ts` (добавить `image` chunk в `promptInputSchema`, лимит < 250 строк)
  - Modify: `src/host/prompt-input.ts` (функция `resolvePromptInput` с чтением файлов, детекцией MIME и base64 кодированием, лимит < 250 строк)
  - Test: `tests/multimodal-input-resolver.test.ts`
- **Tasks:**
  - [x] **Step 1:** Написать падающий TDD-тест в `tests/multimodal-input-resolver.test.ts` (парсинг `text + localImage`, только `localImage`, `data:image/png;base64,...`).
  - [x] **Step 2:** Запустить тест, убедиться в падении.
  - [x] **Step 3:** Добавить `image` вариант в `promptInputSchema` в `src/host/types.ts`.
  - [x] **Step 4:** Реализовать `resolvePromptInput` в `src/host/prompt-input.ts`.
  - [x] **Step 5:** Проверить прохождение тестов и бюджеты AP-019.

---

### Slice 98.2 (P1): Host-to-Runner Multimodal Bridge & Controller Submission (`src/host/bridge-router.ts`, `src/host/session.ts`, `src/runner/`)
- **Primary Source / Evidence:** `bridge-router.ts:98` блокировал ход с `-32602 Missing input text`, если текст пуст, даже если прикреплены картинки. `session.prompt()` и `handleActiveSessionCommand` принимали только `string`.
- **Touched Files:**
  - Modify: `src/host/bridge-router.ts` (проверка `!textSummary && !hasImages`, передача `content`, лимит < 250 строк)
  - Modify: `src/host/session.ts` (`prompt` и `steer` принимают `PromptContent = string | (TextContent | ImageContent)[]`, лимит < 250 строк)
  - Modify: `src/runner/session-commands.ts` (декодирование `cmd.content ?? cmd.message`, лимит < 200 строк)
  - Modify: `src/runner/runtime-controller.ts` (извлечение картинок для `emitBeforeAgentStart`, лимит < 200 строк)
  - Modify: `src/runner/runtime-types.ts` (`submit` принимает `UserInput`)
  - Test: `tests/multimodal-bridge-e2e.test.ts`
- **Tasks:**
  - [x] **Step 1:** Написать падающий тест в `tests/multimodal-bridge-e2e.test.ts` (передача картинок без текста в `turn/start`, проверка вызова `controller.submit` с `ImageContent`).
  - [x] **Step 2:** Запустить тест, убедиться в падении.
  - [x] **Step 3:** Реализовать изменения в `src/host/bridge-router.ts`, `src/host/session.ts`.
  - [x] **Step 4:** Реализовать изменения в `src/runner/session-commands.ts`, `src/runner/runtime-controller.ts`, `src/runner/runtime-types.ts`.
  - [x] **Step 5:** Прогнать полный тестовый люкс `npm test` и проверку типов `npx tsc --noEmit`.

---

### S9: Dual-Circuit Verification Gate
- [x] Запустить независимое архитектурное ревью (S9a) по скиллам `arch-rules-implementation-review` и `arch-improvement-review`.
- [x] Запустить независимое продуктовое ревью (S9b) по скиллу `arch-improvement-product-review` (Black-Box testing: Happy Path с картинкой, только картинка, невалидный файл).
- [x] Получить `VERDICT: PASS` от обоих контуров.

---

### S10: Release & Activation
- [x] Повысить версию до **`0.2.45`** в `package.json`.
- [x] Собрать релиз `npm run build`.
- [x] Закоммитить и запушить в `main`, поставить тег `v0.2.45`.
- [ ] Обновить живой плагин в BB IDE через `bb plugin update provider-pi-durable --yes`.
- [ ] Закрыть Issue #11 на GitHub.
