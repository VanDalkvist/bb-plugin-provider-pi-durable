# Arch Improvement Cycle 107: Session Lifecycle Hooks, Admission Receipts and Codemode Sandbox Isolation

- **Цель:** Реализовать архитектурные требования внешних исследователей (`Diffuzmetall/pi-durable-host`), устранив гонки возобновления сессий через хук `beforeResume`, обеспечив атомарный возврат `AdmissionReceipt` из `controller.submit()` и полностью изолировав песочницу QuickJS Codemode от кросс-сессионного загрязнения.
- **Связанный аудит:** `docs/arch-improvement/audits/2026-11-02-cycle-107-admission-hooks-and-sandbox-isolation-audit.md`
- **Архитектурные правила (AP Gates):**
  - AP-003 (Protocol & Contract Completeness): Возврат атомарного чека допуска `AdmissionReceipt`.
  - AP-010 (Hexagonal Architecture / Ports & Adapters): Чистая изоляция домена, адаптеров и хуков жизненного цикла.
  - AP-013 (Data Integrity & State Isolation): Изоляция состояния сессий и песочниц в памяти.
  - AP-014 (Defensive Concurrency & Lifecycle Invariants): Детерминированный порядок инициализации (`beforeResume` строго перед `resume`).
  - AP-019 (Line Budgets): Каждый файл строго < 250 LOC.

---

## Architecture Context Map

- **Stage:** scale / hardening
- **Source docs:**
  - `docs/arch-improvement/audits/2026-11-02-cycle-107-admission-hooks-and-sandbox-isolation-audit.md`
  - `durable-zero/packages/core/src/runtime.ts`
  - `durable-zero/packages/core/src/runtime-types.ts`
  - `durable-zero/packages/core/src/runtime-controller.ts`
  - `durable-zero/packages/core/src/builtin-extensions/codemode.ts`
- **Active paths:**
  - `durable-zero/packages/core/`
  - `bb-plugin-provider-pi-durable/`
- **Critical gates:** AP-003, AP-010, AP-013, AP-014, AP-019
- **Baseline gates:** AP-012, AP-020, AP-022, AP-023
- **Verification surface:**
  - `pnpm --filter @durable-zero/contracts test`
  - `pnpm --filter @durable-zero/core test`
  - `pnpm --filter @durable-zero/cli test`
  - `pnpm test` (монорепозиторий `durable-zero`)
  - `npm test` в `bb-plugin-provider-pi-durable`
  - `npm run test:contracts` в `bb-plugin-provider-pi-durable`
  - `node scripts/verify-layer-boundaries.mjs`

---

## Triage: Решения по дефектам

- `fix-now`:
  - **D-107-01 (P1):** Добавление хука `beforeResume?: (harness: Harness) => Promise<void>` в `OpenDurableOptions` и вызов в `openDurable` строго перед `await harness.resume()`.
  - **D-107-02 (P1):** Возврат атомарного `Promise<AdmissionReceipt>` из `DurableController.submit()` с обновлением типов и потребителей.
  - **D-107-03 (P2):** Ликвидация синглтона `let activeSandbox` в `packages/core/src/builtin-extensions/codemode.ts`, инкапсуляция песочницы в классе `CodemodeExtension` и фабрике `createCodemodeBuiltinExtension()`.
- `log-only`:
  - Нет.
- `blocked`:
  - Нет.

---

## План пошаговой реализации (Slices)

### Slice 1: Хук `beforeResume` в `openDurable` (@durable-zero/core)
- **Boundary:** Lifecycle / Composition Root (`packages/core/src/runtime.ts`, `runtime-types.ts`)
- **AP gates:** AP-010, AP-014, AP-019
- **Red test first:**
  - Написать тест `packages/core/test/before-resume.test.ts`:
    - Передать опцию `beforeResume` в `openDurable`.
    - Убедиться, что хук получает экземпляр `harness`.
    - Подтвердить через перехват `harness.resume`, что `beforeResume` завершается СТРОГО до вызова `harness.resume()`.
- **Expected failure:** TypeScript ошибка `Property 'beforeResume' does not exist on type 'OpenDurableOptions'`.
- **Implementation:**
  - Добавить `beforeResume?: (harness: Harness) => Promise<void>` в `OpenDurableOptions` в `runtime-types.ts`.
  - В `packages/core/src/runtime.ts` вызвать:
    ```ts
    await options.beforeResume?.(harness);
    await harness.resume();
    ```
- **Passing test:**
  - `node --test packages/core/test/before-resume.test.ts` проходит 100% green.
- **Verification:** Все тесты `durable-zero/packages/core`.

---

### Slice 2: Возврат Admission Receipt из `controller.submit()` (@durable-zero/core)
- **Boundary:** Controller / Submission Lifecycle (`packages/core/src/runtime-controller.ts`, `runtime-types.ts`)
- **AP gates:** AP-003, AP-010, AP-013, AP-019
- **Red test first:**
  - Написать тест в `packages/core/test/admission-receipt.test.ts`:
    - Вызвать `controller.submit("test", "followUp")`.
    - Проверить, что результат является объектом `{ requestId: string; conversationId: string; status: "accepted"; sequence?: number }`.
- **Expected failure:** Тест падает, так как `submit` возвращает `undefined` (тип `Promise<void>`).
- **Implementation:**
  - Объявить интерфейс `AdmissionReceipt` в `runtime-types.ts` и экспортировать его.
  - Обновить сигнатуру `submit(...)` в `DurableController`: возвращает `Promise<AdmissionReceipt>`.
  - В `runtime-controller.ts` обновить хелпер `command = <T = void>(operation: () => Promise<T>): Promise<T>` и возвращать квитанцию из `submit`:
    ```ts
    const submission = await ctx.bindings.current.submit({ type: "input", content: input, whenBusy }, runtimeContext);
    watchAnswer(submission);
    const seq = typeof submission.id === "number" ? submission.id : !isNaN(Number(submission.id)) ? Number(submission.id) : undefined;
    return {
      requestId: String(submission.id),
      conversationId: String(ctx.bindings.current.id),
      status: "accepted",
      ...(seq !== undefined ? { sequence: seq } : {}),
    };
    ```
  - Обновить `DurableEngine.prompt()` в `engine.ts` и `packages/core/src/index.ts`.
- **Passing test:**
  - `node --test packages/core/test/admission-receipt.test.ts` проходит 100% green.
- **Verification:** Прогон всех тестов `durable-zero`.

---

### Slice 3: Изоляция песочницы Codemode (@durable-zero/core)
- **Boundary:** Built-in Extensions / QuickJS Sandbox (`packages/core/src/builtin-extensions/codemode.ts`)
- **AP gates:** AP-010, AP-013, AP-019
- **Red test first:**
  - Написать тест в `packages/core/test/codemode-sandbox-isolation.test.ts`:
    - Создать два независимых реестра `createCodingRegistry` (или зарегистрировать расширение в двух контекстах).
    - Проверить, что песочницы изолированы и не перезаписывают друг друга.
    - Вызвать `teardown()` первого расширения и проверить, что песочница второго расширения остаётся нетронутой.
- **Expected failure:** При использовании старого кода `activeSandbox` перезаписывается и teardown первого ломает второй.
- **Implementation:**
  - В `packages/core/src/builtin-extensions/codemode.ts`:
    - Удалить модульную переменную `let activeSandbox`.
    - Создать класс `CodemodeExtension implements BuiltinExtension`.
    - Добавить фабрику `createCodemodeBuiltinExtension()`.
    - Сохранить обратную совместимость через `export const codemodeExtension = new CodemodeExtension()`.
  - В `packages/core/src/harness-setup.ts`:
    - Использовать `createCodemodeBuiltinExtension()` при сборке реестра.
- **Passing test:**
  - `node --test packages/core/test/codemode-sandbox-isolation.test.ts` проходит 100% green.
- **Verification:** Все тесты `durable-zero`.

---

### Slice 4: Двухконтурная верификация, сборка раннера, аудит бюджетов и Ledger
- **Boundary:** Verification & Audit
- **AP gates:** AP-019, AP-020, AP-022, AP-023
- **Verification Commands:**
  - `pnpm --filter @durable-zero/core run build:runner`
  - `pnpm --filter @durable-zero/core run build`
  - `pnpm test` в `durable-zero`
  - `npm test` в `bb-plugin-provider-pi-durable`
  - `npm run test:contracts` в `bb-plugin-provider-pi-durable`
  - `node scripts/verify-layer-boundaries.mjs`
  - Проверка бюджетов LOC: `wc -l` (< 250 LOC на файл).
- **Artifacts:**
  - Запись в `docs/arch-improvement/ledger.md` (Cycle 107).
  - Запись в `docs/arch-improvement/memory.md`.
