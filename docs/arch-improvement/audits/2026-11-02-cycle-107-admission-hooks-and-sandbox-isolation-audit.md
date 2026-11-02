# Архитектурный аудит: Хуки жизненного цикла сессий, атомарные Admission Receipts и изоляция песочницы Codemode

- **Дата:** 2026-11-02
- **Цикл:** Cycle 107
- **Объекты аудита:** `durable-zero` (`packages/core/src/runtime.ts`, `runtime-controller.ts`, `runtime-types.ts`, `builtin-extensions/codemode.ts`), `bb-plugin-provider-pi-durable`
- **Основание:** Архитектурный аудит внешних исследователей (ветка `Diffuzmetall/pi-durable-host`)
- **Статус:** FAIL (Требуется устранение гонок возобновления, обеспечение атомарной квитанции допуска и изоляция параллельных песочниц)

---

## 1. Контекст и проблематика

В ходе исследования интеграции `durable-zero` с многопоточными хостами и анализа ветки `Diffuzmetall/pi-durable-host` выявлены три архитектурных дефекта, влияющих на предсказуемость жизненного цикла, надежность распределения задач и параллелизм:

1. **Отсутствие хука `beforeResume` в `openDurable` (P1)**:
   При открытии сессии `openDurable` в `packages/core/src/runtime.ts` немедленно вызывается `harness.resume()`. Если хосту или внешнему координатору требуется выполнить подготовительные действия (зарегистрировать вотчеры, подготовить подписки, синхронизировать контекст или зафиксировать слушатели задач) СТРОГО до того, как задачи сессии возобновят выполнение, возникает состояние гонки: задачи начинают исполняться в фоновом планировщике до завершения инициализации хоста.

2. **Потеря детерминированной квитанции допуска из `controller.submit()` (P1)**:
   Метод `DurableController.submit()` возвращает `Promise<void>`. Вызывающая сторона не получает атомарный идентификатор принятого запроса (`AdmissionReceipt`), что препятствует сквозной корреляции запроса хоста с конкретной отправкой (`SubmissionId` / `sequence`) и вынуждает хост строить эвристики или повторно сканировать базу.

3. **Синглтон песочницы Codemode на уровне модуля (P2)**:
   В `packages/core/src/builtin-extensions/codemode.ts` переменная `let activeSandbox: CodemodeSandbox | undefined` объявлена на уровне модуля. При параллельном открытии нескольких сессий (или вложенных субагентов) регистрация второго экземпляра перезаписывает активную песочницу первого, а вызов `teardown()` первой сессии преждевременно уничтожает песочницу второй.

---

## 2. Локализация дефектов

### Дефект D-107-01 (P1): Гонка возобновления сессии (Missing `beforeResume` hook)
- **Файл:** `durable-zero/packages/core/src/runtime.ts:160`
- **Проявление:**
  ```ts
  await controller.toggleTasks();
  harness.resume(); // Немедленный запуск фонового планировщика без точки перехвата
  ```
- **Нарушение канона:**
  AP-010 (Lifecycle Invariants), AP-014 (Defensive Concurrency). Хост не имеет детерминированного способа выполнить фазу подготовки до старта планировщика.
- **Решение:**
  Добавить `beforeResume?: (harness: Harness) => Promise<void>` в `OpenDurableOptions`. Вызывать `await options.beforeResume?.(harness)` СТРОГО перед `await harness.resume()`.

### Дефект D-107-02 (P1): Отсутствие Admission Receipt в `controller.submit()`
- **Файлы:**
  - `durable-zero/packages/core/src/runtime-controller.ts:54, 105`
  - `durable-zero/packages/core/src/runtime-types.ts:68`
- **Проявление:**
  Метод `submit` возвращает `Promise<void>`, скрывая результат `ctx.bindings.current.submit(...)`, который содержит `submission.id` и привязку к `conversationId`.
- **Нарушение канона:**
  AP-003 (Protocol & Contract Completeness), AP-013 (Data Integrity & Tracking).
- **Решение:**
  Возвращать атомарный `Promise<AdmissionReceipt>`:
  ```ts
  export interface AdmissionReceipt {
    readonly requestId: string;
    readonly conversationId: string;
    readonly status: "accepted";
    readonly sequence?: number;
  }
  ```

### Дефект D-107-03 (P2): Утечка состояния песочницы QuickJS между сессиями
- **Файл:** `durable-zero/packages/core/src/builtin-extensions/codemode.ts:5, 11, 21`
- **Проявление:**
  `activeSandbox` хранится в модульном замыкании. Параллельные вызовы `createCodingRegistry` мутируют одну и ту же глобальную переменную.
- **Нарушение канона:**
  AP-010 (Hexagonal Isolation), AP-013 (State Encapsulation).
- **Решение:**
  Инкапсулировать состояние в класс `CodemodeExtension implements BuiltinExtension` и фабрику `createCodemodeBuiltinExtension()`. Хранить песочницы в контексте сессии и экземпляре расширения, гарантируя независимый `teardown()`.

---

## 3. Целевое состояние и план верификации

1. `OpenDurableOptions` расширен хуком `beforeResume`.
2. `DurableController.submit()` возвращает `AdmissionReceipt`.
3. `CodemodeExtension` изолирован на уровне экземпляра и контекста.
4. 100% тестов проходят в `durable-zero` и `bb-plugin-provider-pi-durable`.
5. 0 нарушений бюджетов строк (AP-019 < 250 LOC).
