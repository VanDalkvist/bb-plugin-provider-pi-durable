# Архитектурное ревью: приёмка исправления дельт изменений файлов (File-Change Delta Micro-Loop, S9a)

- **Дата:** 2026-10-25
- **Объект ревью:** `bb-plugin-provider-pi-durable`
- **Проверяемый кандидат:** коммит `f11f89de3bebbd805579ebd87edc4c617d90d376` (база: `332ef07`)
- **Контур проверки:** узкая приёмка S9a для микро-лупа расследования и исправления дельт изменений файлов (File-change Delta Micro-loop). Политика субагентов закрыта ранее и не пересматривается.
- **Базовые правила:** `arch-rules` (AP-010 – AP-071), `bb-plugin-provider-pi-durable/AGENTS.md`, `~/Projects/AGENTS.md`
- **Канонический план задачи:** `docs/superpowers/plans/2026-10-25-file-change-delta-micro-loop.md`
- **Отчёт расследования:** `docs/arch-improvement/reviews/2026-10-25-file-change-delta-investigation.md`

---

## 1. Анализ корневых причин и архитектурных границ

В ходе расследования на реальных SQLite-логах сессии `thr_wwgrn2pqdu` и исходниках `@earendil-works/pi-coding-agent@1.3.0` были подтверждены две взаимосвязанные корневые причины визуальной фрагментации и усечения диффов:

1. **Фрагментация идентичности файла при мульти-региональном редактировании (Root Cause 1):**
   - В нативном инструменте `edit` один вызов (`tool_execution_start`) работает ровно с одним файлом (`args.path`), передавая массив регионов замены `args.edits`.
   - В адаптере `buildToolItemShape` (`src/host/tool-item-shape.ts`) каждый регион ошибочно мапился в отдельный элемент массива `changes`.
   - В протоколе BB Provider Bridge каждый элемент `changes` представляет собой **отдельный файл**, а не отдельный регион. Сервер BB (`delta-assembler`) разворачивал массив `changes` в N независимых строк таймлайна (`file-change:0`, `file-change:1`, ...), дублируя один и тот же файл несколько раз.

2. **Приоритет терминального TUI-диффа над каноническим унифицированным git-патчем (Root Cause 2):**
   - Upstream-инструмент `edit` в `@earendil-works/pi-coding-agent` возвращает в `details` два поля:
     - `details.diff`: форматированная TUI-строка для вывода в терминал (содержит номера строк вида `+ 1 ...`, `  1 ...`, многоточия `...` вместо заголовков `@@`);
     - `details.patch`: стандартный унифицированный POSIX/git diff со всеми валидными `@@ -start,count +start,count @@` заголовками для всех заменённых блоков.
   - Функция `resolveFileChangeItem` (`src/host/diff-utils.ts`) проверяла `detailsObj?.diff` раньше `detailsObj?.patch`. В результате TUI-строка всегда вытесняла канонический патч.
   - Парсер интерфейса BB IDE (`dist-CXXcNKpg.js`), не обнаружив `@@` заголовков, фабриковал искусственный заголовок первого блока и при первой же неизменённой секции кода (на строках 6–8) преждевременно прерывал обработку (`T >= additionCount && E >= deletionCount -> break`), усекая дифф файла до `+1 -0` и скрывая до 90% изменений.

3. **Локальность и чистота исправления:**
   - Изменения затронули строго два production-файла адаптера: `src/host/tool-item-shape.ts` (удалено фрагментирование на несколько записей `changes`) и `src/host/diff-utils.ts` (выставлен строгий приоритет `details.patch` над `details.diff`).
   - Идентичность отдельных вызовов и разных файлов не смешивается: каждый вызов инструмента сохраняет уникальный `providerItemId` (`toolCallId`).
   - Сохранена полная обратная совместимость для кастомных провайдеров с `diff-only` (без поля `patch`), а также синтез диффов для инструмента `write` (`kind: "add"`).
   - Никаких фиктивных патчей из сниппетов, эвристических TUI-парсеров или переписывания ядра BB не потребовалось.

---

## 2. Проверка исправлений (Findings & Fix Verification)

### [P1] Дублирование строк таймлайна для одного файла при вызове edit с несколькими регионами
- **Evidence:** `src/host/tool-item-shape.ts:50–60`, коммит `f11f89de3bebbd805579ebd87edc4c617d90d376`.
- **Status:** **ЗАКРЫТО (CLOSED)**.
- **Verification:**
  - `buildToolItemShape("edit", { path: "sample.ts", edits: [...] })` теперь возвращает строго один элемент:
    `changes: [{ path: filePath, kind: "update" }]`.
  - Тест `tests/native-edit-file-change.test.ts` (кейс `"native multi-hunk edit translates to single fileChange item with canonical unified git diff"`) подтверждает: `startItem.changes.length === 1`, `endItem.changes.length === 1`.
  - Устаревший тест `tests/tool-delta-translator.test.ts` обновлён: проверка `changes.length === 2` заменена на инвариант единой сущности файла `changes.length === 1`.

### [P1] Усечение диффов и потеря ханков из-за приоритета TUI details.diff над details.patch
- **Evidence:** `src/host/diff-utils.ts:133–140`, коммит `f11f89de3bebbd805579ebd87edc4c617d90d376`.
- **Status:** **ЗАКРЫТО (CLOSED)**.
- **Verification:**
  - В `resolveFileChangeItem` порядок выбора изменён: сначала проверяется `typeof detailsObj?.patch === "string"`, и только при его отсутствии — `typeof detailsObj?.diff === "string"`.
  - Семантическая проверка в `tests/native-edit-file-change.test.ts`: реальный вызов `createEditTool` из `@earendil-works/pi-coding-agent` генерирует 3 разобщённых ханка на 60 строках кода. Переведённый дифф содержит стандартный заголовок `diff --git a/sample.ts b/sample.ts`, парсится библиотекой `diff` (`parsePatch`) ровно на 3 ханка, а `applyPatch(before, diff)` даёт байт-в-байт идентичный `after`-контент, созданный инструментом.
  - Схема BB SDK `threadDeltaSchema.safeParse(end).success === true` подтверждает полную контрактную валидность сформированного дельта-события.

### [P2] Сохранение изоляции отдельных вызовов и поддержка diff-only провайдеров
- **Evidence:** `tests/native-edit-file-change.test.ts:122–160`.
- **Status:** **ЗАКРЫТО (CLOSED)**.
- **Verification:**
  - Тест `"distinct edit calls on different files preserve separate call identity and do not merge"` подтверждает, что вызовы `call_a` (fileA.ts) и `call_b` (fileB.ts) генерируют независимые `providerItemId` и не сливаются.
  - Тест `"custom producer with valid diff-only (no patch field) remains supported"` подтверждает, что провайдеры без поля `patch` штатно нормализуются функцией `normalizeGitPatch`.
  - Инструмент `write` (`kind: "add"`) продолжает корректно синтезировать canonical add diff через `synthesizeAddDiff` (тесты в `tests/tool-delta-translator.test.ts` остаются 100% зелёными).

---

## 3. Архитектурная верификация (Architecture Verification Matrix)

- **Passed AP Rules:**
  - **AP-010 (Modular Monolith + Ports & Adapters):** Исправление изолировано внутри адаптера трансляции инструментальных событий хоста (`tool-item-shape.ts` и `diff-utils.ts`), не вторгаясь в раннер, движок исполнения или ядро BB.
  - **AP-011 (Low Coupling & High Cohesion):** Логика представления дельт сосредоточена в специализированных модулях без размазывания по сессиям.
  - **AP-012 (Fail-Fast & Explicit Error Contracts):** Отсутствие `patch` или повреждённый вход не маскируются случайными догадками; при отсутствии деталей дифф остаётся undefined без генерации фиктивных патчей.
  - **AP-013 (Data Integrity Without Fallbacks):** Унифицированный патч гарантирует сохранение всех ханков, номеров строк и изменений. Байт-в-байт соответствие доказано через `applyPatch(before, diff) === after`.
  - **AP-015 (DRY, KISS, YAGNI):** Использован готовый канонический unified patch из upstream, без написания обратного парсера TUI-разметки или дублирования diff-движков.
  - **AP-019 (File Line Budgets):**
    - `src/host/tool-item-shape.ts`: 69 строк (норматив < 150 / 200 строк строго соблюдён).
    - `src/host/diff-utils.ts`: 183 строки (норматив < 200 / 250 строк строго соблюдён).
  - **AP-026 (API Contracts & DTO Boundaries):** Результирующий `fileChange` удовлетворяет официальной схеме `threadDeltaSchema` из `@get-bb/plugin-sdk/provider-bridge`.
  - **AP-028 (Testing Strategy & Determinism):** Добавлен комплекс детерминированных тестов с реальным `createEditTool` Pi 1.3 на временных файловых изолированных каталогах без моков и без сетевых зависимостей.

- **Non-applicable AP Rules:**
  - AP-033, AP-034, AP-061, AP-062 (БД, транзакции, миграции): задача не затрагивает базы данных.
  - AP-039, AP-040, AP-042 (Аутентификация и секреты): работа с секретами не велась.

- **Residual Risk:**
  - **Отсутствие live UI rollout:** Изменения верифицированы на уровне исходного кода, тестов и артефактов сборки (`npm run build`). Установленный в BB плагин не обновлялся и не перезапускался. Переключение существующих тредов проверяется отдельной процедурой обновления; эта кодовая приёмка не предписывает перезапуск BB/хост-демона и не утверждает live rollout.

---

## 4. Контрольные результаты проверок

1. **Unit & Integration тесты:** 399 тестов Node.js + 9 тестов UI (всего 408 тестов) — **100% PASS (0 failures)**.
2. **TypeScript Strict Typecheck (`npx tsc --noEmit`):** exit code 0, 0 ошибок.
3. **Runner Packaging:** бандл `dist/runner/index.js` не изменился и составляет **143,947 байт** (в пределах норматива < 200 КБ).
4. **Host Build (`npm run build`):** артефакты `dist/host.js`, `dist/server.js`, `dist/app.js` успешно пересобраны.
5. **SDK CLI check deviation:** команда `bb plugin types --check` возвращает exit 1 из-за нахождения SDK в production `dependencies` (требование автономного provider bridge; задокументированное платформенное отклонение, не считающееся ошибкой кода).

---

## Итоговый вердикт

# **VERDICT: PASS**

Все требования спецификации микро-лупа выполнены: единая идентичность файла для всех регионов замены обеспечена, унифицированный многоханковый git-патч доставляется без усечений и проверяется через `applyPatch`, бюджет строк AP-019 и контрактные тесты полностью зелёные.
