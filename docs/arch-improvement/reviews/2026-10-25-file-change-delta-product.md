# Продуктовое ревью: приёмка дельт изменений файлов [S9b: Product Verify Gate]

- **Дата:** 2026-10-25
- **Объект ревью:** `bb-plugin-provider-pi-durable`
- **Проверяемый кандидат:** коммит `f11f89de3bebbd805579ebd87edc4c617d90d376` (`f11f89d`)
- **Контур проверки:** продуктовый дата-плейн (Black-Box Synthetic User & Public SDK Consumer Verification)
- **Метод верификации:** анализ наблюдаемых captured `thread/delta` JSON-RPC уведомлений через внешний диагностический CLI и публичный consumer SDK `@get-bb/plugin-sdk/provider-bridge/testing` (`experimental_assembleCapturedThreadEvents`), без чтения внутренней реализации плагина.

---

## 1. Executed User Journeys (Выполненные пользовательские сценарии)

### 1. Happy Path: Реальное многорегиональное редактирование файла (Native Multi-Region Edit)
- **Действие:** Запуск сценария `case-1-native-multi-region-edit` через диагностический интерфейс:
  ```bash
  BB_THREAD_STORAGE=/Users/vanya/.bb/thread-storage/thr_squn93nr4e node /Users/vanya/.bb/thread-storage/thr_squn93nr4e/investigation/diagnostic-cli.mjs
  ```
  И независимая проверка сборки потока событий через `experimental_assembleCapturedThreadEvents`:
  ```javascript
  const events = experimental_assembleCapturedThreadEvents([scenario.notification], "pi-durable");
  ```
- **Проверки и наблюдаемый результат:**
  - **Поток событий потребителя:** `turn/started -> item/started -> item/completed -> turn/completed`.
  - **Уникальность записи файла:** Ровно 1 запись изменения (`changes.length === 1`), отдельные ханки не расщепляются на дублирующие файловые блоки.
  - **Нормализация пути:** Чистый путь `src/calculator.ts` без артефактов `b/` или относительных точек.
  - **Канонический заголовок git diff:** Присутствует корректный заголовок `diff --git a/src/calculator.ts b/src/calculator.ts` и маркеры `--- a/...` / `+++ b/...`.
  - **Сохранность разнесённых ханков:** Ровно 3 изолированных ханка (`hunkCount === 3`) для строк 5, 30 и 55.
  - **Байт-в-байт применимость патча:** `applyPatch(beforeContent, diff) === actualAfterContent` возвращает `true`. Дифф полностью валиден для стандартного парсера git/diff.
- **Исход сценария:** PASS.

### 2. Cold / No Operations: Холостой ход без операций над файлами
- **Действие:** Запуск сценария `case-2-cold-no-operations` на холостом ходе агента без вызовов инструментов `edit` / `write`.
- **Проверки и наблюдаемый результат:**
  - **Поток событий потребителя:** Чистый переход `turn/started -> turn/completed`.
  - **Чистота состояния:** Ровно 0 элементов типа `fileChange`.
  - **Отсутствие артефактов:** Никаких фиктивных diffs, пустых обновлений файлов или ложных ошибок.
- **Исход сценария:** PASS.

### 3. Error Recovery: Ошибка редактирования при несовпадении `oldText`
- **Действие:** Запуск сценария `case-3-failing-edit-missing-oldtext` при попытке редактирования файла с неверным искомым фрагментом текста.
- **Проверки и наблюдаемый результат:**
  - **Поток событий потребителя:** `turn/started -> item/started -> item/completed -> turn/completed`.
  - **Неприкосновенность файла на диске:** `beforeContent === actualAfterContent` (файл не был повреждён или частично изменён).
  - **Терминальный статус элемента:** `status: "failed"` (нет ложного `completed`).
  - **Отсутствие сфабрикованного диффа:** Поле `diff` в `changes` отсутствует, ложный diff не генерируется.
  - **Информативность ошибки:** Сообщение об ошибке («Could not find the exact text in src/strict-config.ts...») передано пользователю.
- **Исход сценария:** PASS.

### 4. Изоляция отдельных вызовов и файлов
- **Действие:** Проверка изоляции независимых вызовов инструмента `edit` для разных файлов (`tests/native-edit-file-change.test.ts: distinct edit calls on different files preserve separate call identity and do not merge`).
- **Результат:** Вызовы для `fileA.ts` и `fileB.ts` сохраняют независимые `providerItemId` (`call_a`, `call_b`) и не склеиваются в одну операцию.

---

## 2. Findings (Находки)

Findings: - None

Все три обязательных продуктовых сценария (Happy Path с многозонным редактированием, Cold Start, Error Recovery) выполнены полностью и успешно валидированы на уровне публичного контракта SDK.

---

## 3. Product Verification (Матрица продуктовой проверки)

- **Primary Journey Complete (Многозонный Edit):** YES
  - Сгенерирован единый `fileChange` элемент с каноническим унифицированным diff.
  - Все 3 ханка сохранены без потерь контекста.
  - Патч применяется байт-в-байт к исходному содержимому.
- **Feedback & Error Clarity (Ошибки и пустые состояния):** YES
  - Холостой ход не создаёт паразитных элементов изменения файлов.
  - Ошибочный вызов инструмента честно завершается со статусом `failed`, сохраняя файл нетронутым и не генерируя синтетический diff.
- **Clean State & Clean Exit:** YES
  - Поток событий `thread/delta` детерминирован и успешно агрегируется публичным хелпером `experimental_assembleCapturedThreadEvents`.
- **Honest Residual User Risk:**
  1. *Визуальный рендеринг в live UI:* Проверка проведена строго на кодовом data-plane boundary через реальные captured уведомления и consumer SDK. Визуальное отображение диффа в UI-виджете настольного BB IDE (Diff Viewer) после отдельно согласованного обновления плагина ещё предстоит подтвердить при реальной эксплуатации. Установка/reload этим циклом не выполнялись; необходимость перезапуска BB/хоста из этой проверки не следует.
  2. *Повторное чтение build outputs:* Первоначальный parent readback кратковременно увидел dirty `dist/app.css`. Последующая проверка подтвердила байтовую идентичность committed blob и чистый `git diff` по src/tests/dist; вариация CSS-правил не установлена. Свидетельство: parent `delta-post-build-readback.json`.

---

## Итоговый вердикт

**VERDICT: PASS**
