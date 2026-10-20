# Track 2: Глубокое исследование Upstream Pi 1.3.0 (Cycle 93)

**Дата:** 20 октября 2026 г.  
**Роль:** Независимый глубокий исследователь (Track 2)  
**Объект анализа:** Исходный код первоисточников upstream Pi в `/Users/vanya/Projects/pi` (`packages/durable`, `packages/chord`, `packages/ai`, `packages/coding-agent`) между тегами `v1.2.0` и `v1.3.0`, а также коммиты на `origin/main` после релиза 1.3.0.  
**Целевой плагин:** `bb-plugin-provider-pi-durable` (`/Users/vanya/Projects/bb-plugin-provider-pi-durable`).

---

## 1. Обзор релиза 1.3.0 и ключевые изменения upstream

Релиз Pi v1.3.0 (коммит `71023aec1`, 15 октября 2026 г.) и последующие коммиты на ветке `main` представляют собой системное развитие архитектуры платформы:
1. **Durable Core:** Введена поддержка изолированных пространств имен в SQLite (`namespaced SQLite storage`, PR #10937), исправлены критические дефекты контекстной деривации после компакшна (#10904), кардинально оптимизировано потребление памяти при base64-кодировании изображений (#10923), а в ветку `main` добавлены точечные оверрайды компакшна на уровне моделей (`modelOverrides`, #10942) и нормализация `ToolControl.terminate: boolean` (#10858).
2. **Chord:** Выделен специализированный сабпас `@earendil-works/chord/output` для стриминговых буферов (`OutputBuffer`) и контроля частоты коммитов (`Progress`), а также совершён переход на протокол связей Chord v4 (с типизированными принципалами, flow-control и сжатием больших фреймов).
3. **Pi-AI:** Решена фундаментальная проблема HTTP 400 в Anthropic при наличии изображений в ошибочных результатах инструментов (#10794) через изящное разделение `splitErrorToolResultImages`; внедрен протокол `configuration_update` для сохранения промпт-кеша OpenAI при переключении уровня thinking (#10930); добавлена поддержка `thinkingLevel` для семейства Gemini 4 (#10890); изолированы рассуждения разных моделей при смене модели (#11000); нормализован парсинг аргументов тулов с исправлением невалидных escape-последовательностей `\u` (#10868) и строгой валидацией завершенных вызовов (`argumentsError`, #10944).
4. **Coding-Agent:** Реализовано восстановление активного набора инструментов при возобновлении сессии из транскрипта (`session resume`, #10887); зафиксированы точные версии внутренних зависимостей (#10865).

---

## 2. Детальный разбор фич и фиксов по компонентам

### 2.1. Пакет `@earendil-works/pi-durable`

#### А. Namespaced SQLite storage (#10937, коммит `f7e3cb543`)
* **Суть изменения:** В `packages/durable/src/storage/sqlite/schema.ts` вынесена фабрика идентификаторов схем `createSqliteSchema(prefix?: string)`. Все имена таблиц (`durable_metadata`, `record_ids`, `conversations`, `entries`, `tasks`, `submissions`, `documents`, `document_revisions`) и индексов генерируются динамически с префиксом.
* **Сигнатура:**
  ```typescript
  export function openNodeSqliteStorage(
      path: string,
      options: NodeSqliteStorageOptions = {},
  ): Promise<SqliteStorage>;
  // где NodeSqliteStorageOptions = NodeSqliteDatabaseOptions & { prefix?: string };
  ```
* **Валидация префикса:** Префикс обязан соответствовать regex `^[A-Za-z_][A-Za-z0-9_]*$` и не может начинаться с `sqlite_` (зарезервировано SQLite engine).
* **Что это дает для изоляции сессий/тредов:**
  1. **Колокация нескольких сессий в одной БД:** Несколько независимых инстансов Durable Storage могут безопасно сосуществовать в одном `.sqlite` файле (например, таблицы `th_root_conversations` и `th_sub_conversations`).
  2. **Изоляция от таблиц хост-приложения:** Если Durable работает в общей базе данных хоста (например, BB IDE или Cloudflare Durable Object), где уже могут существовать таблицы с именами `tasks`, `documents` или `conversations`, префикс `{ prefix: "pi_" }` полностью исключает коллизии имен (`pi_tasks`, `pi_entries` и т.д.).
  3. **Транзакционная согласованность миграций:** Таблица версионирования схемы также именуется с префиксом (`<prefix>durable_schema`), что позволяет независимо мигрировать схему каждого пространства имен.

#### Б. Перенос `OutputBuffer` и `Progress` в `@earendil-works/chord/output` (коммит `4a5d37291`)
* **Суть изменения:** Классы `OutputBuffer`, `Progress`, функции `boundOutput`, `sanitizeOutput`, `characterEnd`, `utf8ByteLength`, а также типы `OutputLimits`, `BoundedOutput`, `OutputSlice`, `OutputSkip` перемещены из внутреннего модуля `packages/durable/src/harness/output.ts` в публичный экспорт `@earendil-works/chord/output`.
* **Внутреннее использование в Durable:** `packages/durable/src/truncate.ts` теперь реэкспортирует `utf8ByteLength` из `@earendil-works/chord/output`.
* **Влияние на внешних потребителей:** `@earendil-works/chord` теперь предоставляет единый, высокопроизводительный стандарт для ограничения стримингового вывода консоли и батчинга прогресс-коммитов.

#### В. Исправление контекстной деривации после компакшна (#10904, коммит `5713c9507`)
* **Проблема v1.2.0:** Функция деривации контекста `leadWithSystem` перемещала системное сообщение в начало массива сообщений только тогда, когда перед ним находились **исключительно пользовательские сообщения** (`user`). После компакшна, сохранившего историю с сообщениями ассистента (`assistant`), вновь сформированный системный бейзлайн оказывался **после** сохраненной истории и нового ввода. В результате провайдеры (особенно Anthropic и OpenAI Codex) получали запрос без ведущего системного промпта и без начального набора инструментов (он шел как mid-conversation system update). Это приводило к сбросу промпт-кеша и сбоям инференса.
* **Решение в v1.3.0:** Введена концепция **Harness Baseline** через `findBaseline(head, entries)`. Бейзлайном признается первое вхождение `pi.system` после маркера отсечения компакшна (`head`). В функции `leadWithSystem(messages, baseline)` именно бейзлайн принудительно переносится на индекс `0`, даже если в сохраненном контексте присутствуют сообщения ассистента. Любые последующие системные сообщения остаются на своих позиционных местах.

#### Г. Оптимизация Base64 btoa без конкатенационных деревьев (#10923, коммит `b04299717`)
* **Проблема v1.2.0:** В функции `toBase64` (используемой в инструменте `read` и фотонном процессоре изображений) строковый чанк наращивался посимвольно (`chunk += ...`). Движок V8 создавал гигантские деревья конкатенации строк (`ConsString`), удерживая до 140 МБ кучи (heap) при кодировании картинки размером всего 3 МиБ. В средах с жестким лимитом памяти (128 МБ в Cloudflare Workers / Durable Objects) это вызывало мгновенный Out-Of-Memory (OOM).
* **Решение в v1.3.0:**
  ```typescript
  export function toBase64(bytes: Uint8Array): string {
      const parts: string[] = [];
      for (let i = 0; i < bytes.length; i += 8192) {
          parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192) as unknown as number[]));
      }
      return btoa(parts.join(""));
  }
  ```
  Бинарная строка собирается чанками ровно по 8 КиБ через `String.fromCharCode.apply` и кодируется нативным `btoa()`. Потребление памяти снижено более чем в 10 раз, тест на кодирование 3 МиБ внутри лимита 128 МБ heap проходит безупречно.

#### Д. Пострелизные коммиты (ветка `origin/main`):
1. **`ToolControl.terminate: boolean` (#10858, коммит `6085986e4`):** Ранее поле типизировалось строго как литерал `terminate?: true`. Теперь тип расширен до `boolean` (`terminate?: boolean`). Передача `false` является валидным no-op, что предотвращает TypeScript-ошибки при интеграции с `pi-coding-agent`.
2. **`settings.compaction.modelOverrides` (#10942, коммит `c4cf7957b`):** В `HarnessSettings.compaction` добавлено свойство `modelOverrides?: Record<string, Partial<CompactionPolicy>>`, индексированное по ключу `"provider/modelId"`. Это позволяет одному инстансу Harness динамически применять разные лимиты компакшна (`reserveTokens`, `keepRecentTokens`, `backgroundTokens`) для моделей с малым (32k) и большим (1M+) контекстным окном.
3. **Уточнение ошибки `StorageRequestError` (#11014):** Исключение из фатального закрытия Harness распространяется исключительно на операции чтения (`read`). Если `StorageRequestError` выбрасывается при вызове `commit()` или `mintId()`, сессия переходит в статус `failed`.

---

### 2.2. Пакеты `pi-ai` и `pi-coding-agent`

#### А. Восстановление активного набора инструментов при resume (#10887, коммит `6f2f164ab`)
* **Проблема:** Ранее конструктор `AgentSession` в `pi-coding-agent` всегда инициализировал тулы из исходных настроек процесса, полностью игнорируя динамически активированные тулы в ходе диалога (например, подключенные через `tool_search` или расширения). При возобновлении сессии (`resume`) сессия "забывала" активированные инструменты.
* **Решение:** Метод `_restoreToolsFromTranscript` считывает `current.toolsAdded` из последнего системного сообщения сессии и восстанавливает их через `_setActiveTools(names)`, аккуратно накатывая модификаторы `--tools +name/-name`.

#### Б. Обработка изображений в ошибках тулов для Anthropic (HTTP 400, #10794, коммиты `34a8bb38b`, `5ab7fe74c`)
* **Контекст проблемы:** API спецификация Anthropic Messages API (и Claude on Bedrock) жестко требует: если блок `tool_result` помечен как `is_error: true`, его контент **обязан содержать исключительно текст** (`text`). Если инструмент вернул изображение (скриншот упавшего теста, рендер ошибки), Anthropic отклонял весь запрос с ошибкой `HTTP 400 Client Error`.
* **Эволюция решения:**
  * Коммит `34a8bb38b` грубо вырезал картинки, заменяя их на текст `[image omitted: error tool results cannot contain images]`.
  * Коммит `5ab7fe74c` внедрил каноничную функцию `splitErrorToolResultImages(msg: ToolResultMessage)` в `packages/ai/src/api/transform-messages.ts`:
    1. Картинки внутри блока `tool_result` заменяются плейсхолдером `(image attached after the tool results)`.
    2. Сами изображения извлекаются и прикрепляются в **то же самое сообщение пользователя**, но **после всех блоков результатов инструментов**, предваряясь пояснительным текстом:  
       `Images from the error result of tool call <id> (<name>):`.
    3. Модель Claude **полноценно видит изображения ошибок**, а Anthropic API не выбрасывает HTTP 400.

#### В. Thinking-level и промпт-кеш OpenAI (#10930, коммит `60ac3bcc3`)
* **Проблема:** На моделях OpenAI GPT-6 изменение уровня рассуждений (`reasoning.effort`) на верхнем уровне запроса приводило к полной инвалидации префиксного кеша промпта (prompt cache).
* **Решение:** Если провайдер `openai` работает через API Key и модель поддерживает `compat.supportsMidConvoEffort`, уровень thinking передается не через изменение глобального параметра `reasoning.effort`, а через входные элементы протокола `configuration_update`:
  ```json
  { "type": "configuration_update", "reasoning": { "effort": "medium" } }
  ```
  Элементы `configuration_update` фиксируются перед соответствующими ответами ассистента в истории диалога, благодаря чему вся историческая часть запроса остается байт-в-байт идентичной, а промпт-кеш сохраняется на 100%.

#### Г. Поддержка Thinking в других моделях (Gemini 4, Claude, Xiaomi, кросс-модельный свитчинг)
1. **Gemini 4 Argon (#10890, коммит `1692bba63`):** Для моделей Gemini 4+ на Vertex/Google AI вместо устаревшего `thinkingBudget` теперь отправляется нативный параметр `thinkingLevel: "MEDIUM" | "HIGH"` (`usesGoogleThinkingLevel`).
2. **Claude Haiku 5.5 и Opus 5 (#10753, коммит `dc939913f`):** Данные модели поддерживают полное отключение thinking. При выборе `thinking: off` им теперь корректно отправляется `thinking: { type: "disabled" }` без конфликтующих заголовков `block_binding` или маркеров `output_config.effort`.
3. **Xiaomi MiMo (#10818, коммит `6374c2baf`):** Модели MiMo при уровне `minimal` падали с 400. Теперь для них отдается чистый булев переключатель `thinking on/off`, а в каталоге экспонируются только уровни `off` и `high`.
4. **Кросс-модельная очистка Thinking (#11000, коммит `911309429`):** Ранее при переключении с одной модели на другую (например, Claude -> GPT-6) блоки `thinking` старой модели трансформировались в обычный текст `<thinking>...</thinking>`. Новая модель воспринимала чужие мысли как часть видимого ответа и начинала "галлюцинировать", вываливая рассуждения в пользовательский текст. В 1.3.0 `transformMessages` **полностью отбрасывает блоки thinking других моделей** (`if (!isSameModel) return []`).

#### Д. Валидация аргументов tool-call и исправление `\u` escape (#10868, #10944)
1. **Исправление `\u` escape (#10868, коммит `4b994d5e5`):**
   * В LaTeX/Regex коде модели часто генерируют строки вида `\usepackage{x}` или `\url{...}`.
   * Ранее `VALID_JSON_ESCAPES` включал символ `"u"`. Парсер ошибочно считал `\u` началом валидной 4-значной Unicode-последовательности, падал на синтаксической ошибке, а `partialParse` отбрасывал это поле и все последующие аргументы!
   * В 1.3.0 `"u"` убран из простых эскейпов, а `parseStreamingJson` сохраняет `\usepackage` как литеральный текст `\\usepackage`.
2. **Строгая валидация и `argumentsError` (#10944, коммит `87f9a3641`):**
   * Ранее, если модель сгенерировала битый JSON в конце ответа (например, обрыв строки или синтаксический мусор), стриминговый парсер тихо отдавал валидный префикс. Инструмент вызывался с неполными аргументами (например, `write` с обрезанным кодом).
   * В 1.3.0 введена функция `parseToolCallArguments(json)`: для завершенных вызовов тулов битый JSON приводит к установке `arguments = {}` и заполнению `argumentsError`. Метод `validateToolArguments` выбрасывает понятную ошибку `Invalid arguments for tool "...": <reason>\n\nReceived arguments:\n<raw_json>`, и модель получает шанс исправить свой вызов.

---

## 3. Анализ совместимости и рисков обновления (Breaking Changes, API Diff)

### 3.1. Анализ изменений API в `@earendil-works/pi-durable`
| Интерфейс / Метод | Статус в 1.3.0 | Влияние на плагин |
|---|---|---|
| `Harness.open(...)` | Сохранен (100% обратная совместимость) | Нет риска. Вызовы в `runtime-loader.ts` валидны. |
| `openNodeSqliteStorage(path, options)` | Расширен опциональным `{ prefix?: string }` | Нет риска. Текущий вызов `openNodeSqliteStorage(location.database)` валиден. |
| `ToolControl.terminate` | Изменен с `true` на `boolean` | Нет риска. Устраняет потенциальные TypeScript-ошибки. |
| `HarnessSettings.compaction` | Расширен типом `CompactionSettings` с `modelOverrides` | Нет риска. Наш геттер совместим, открывается возможность упрощения. |
| `Harness/output.ts` | Перенесен в `@earendil-works/chord/output` | Внутренний путь. Наш `src/` не импортировал его напрямую. |

### 3.2. Анализ изменений в `pi-ai` и `chord`
* **Chord v4 Protocol:** Изменения коснулись RPC-ссылок (`Ref<C>`, `variant`, flow-control). Плагин использует только `@earendil-works/chord/context` (`BACKGROUND_CONTEXT`, `Context`) и `@earendil-works/chord` (`AttachedReplicatedState`). Их интерфейсы полностью стабильны.
* **Удаление `AssistantMessageFrame` в `pi-ai`:** Удалены устаревшие типы неиспользуемого экспериментального раннера. В плагине `AssistantMessageFrame` нигде не используется.

### 3.3. Проверка ключевых файлов плагина на слом типов
1. **`src/runner/runtime-loader.ts`:**
   * Импортирует: `DefaultResourceLoader`, `ModelRuntime`, `SettingsManager`, `initTheme`, `Harness`, `openNodeSqliteStorage`.
   * **Вердикт:** Все конструкторы и статические методы (`DefaultResourceLoader`, `ModelRuntime.create`, `SettingsManager.create`, `Harness.open`) имеют неизменные сигнатуры. **Слома типов нет.**
2. **`src/runner/harness-setup.ts`:**
   * Импортирует: `createRegistry`, `NodeExecutionEnv`, `createCodingTools`, `createNodePhotonImages`, `createCodemodeExtension`, `CodemodeSandbox`, `createToolSearchExtension`, `resolveCliModel`.
   * **Вердикт:** Все функции фабрик тулов и расширений принимают те же опции. **Слома типов нет.**
3. **`src/runner/session-storage.ts`:**
   * Не импортирует пакеты `@earendil-works/*` напрямую (работает через Node.js fs/crypto/proper-lockfile).
   * **Вердикт:** **Слома типов нет.**

---

## 4. Практические выводы для плагина (что обновлять, какие костыли выбросить)

### 4.1. Обновление зависимостей в `package.json`
В `package.json` плагина необходимо обновить зависимости:
```json
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^1.3.0",
    "@earendil-works/pi-codemode": "^1.3.0",
    "@earendil-works/pi-durable": "^1.3.0",
    "@get-bb/plugin-sdk": "0.6.15",
    "@types/proper-lockfile": "^4.1.4",
    "proper-lockfile": "^4.1.2",
    "zod": "^4.6.5"
  }
```
*Рекомендация по `overrides`:* Так как upstream Pi зафиксировал внутренние зависимости на `1.3.0` (#10865), при необходимости устранения дубликатов в дереве `npm ls` рекомендуется добавить в `package.json`:
```json
  "overrides": {
    "@earendil-works/chord": "^1.3.0",
    "@earendil-works/pi-ai": "^1.3.0"
  }
```

### 4.2. Устранение локальных костылей (Dead Code & Workarounds)

#### 1. Ликвидация костыля `sanitizeToolResultForAnthropic` (Cycle 91 F-91-5)
* **Где находится:**
  * `src/runner/bridge/tool-result-extractor.ts` (строки 127–140): функция `sanitizeToolResultForAnthropic`.
  * `src/runner/tool-adapter.ts` (строки 129–132): вызов санитизации перед возвратом результата.
  * `tests/anthropic-image-error.test.ts`: тест санитизации.
* **Почему это костыль:** В Cycle 91 мы были вынуждены вырезать изображения из ошибочных ответов тулов, чтобы предотвратить краш Anthropic с кодом HTTP 400. Картинка подменялась заглушкой `[image omitted...]`.
* **Почему его нужно убрать в 1.3.0:** Upstream Pi 1.3.0 на уровне `pi-ai` (`splitErrorToolResultImages`) **нативно решает эту проблему**: результат тула очищается от картинок, а сами картинки прикрепляются следом в том же сообщении пользователя. Если наш плагин продолжает вырезать картинки в `tool-adapter.ts`, upstream-механизм не получает картинок, и Claude **никогда не увидит визуальные артефакты ошибок**!
* **Действие:** Удалить `sanitizeToolResultForAnthropic` из `tool-adapter.ts` и `tool-result-extractor.ts`, доверив преобразование нативному слою `pi-ai`.

#### 2. Оптимизация резолвера компакшна в `harness-setup.ts`
* **Где находится:** `src/runner/harness-setup.ts` (`createHarnessSettings -> get compaction()`).
* **Текущее решение:** Динамический геттер, вычисляющий активную модель через перехват `getActiveModel()`.
* **Возможность 1.3.0+:** С появлением `modelOverrides` в `CompactionSettings` (#10942) настройки компакшна для разных моделей можно передавать декларативно при инициализации Harness, не полагаясь на постоянный опрос замыкания активной модели.

#### 3. Потенциал Namespaced SQLite Storage (#10937)
* В перспективе дальнейшего развития изоляции субтредов (Subagent / Composite IDs): мы можем использовать один SQLite файл для рабочего дерева сессии, разводя сессии по табличным префиксам (`prefix: "th_<threadId>_"`), вместо поддержания множества разрозненных файлов баз данных, либо безопасно хранить сессионные данные рядом с базами данных плагинов BB IDE.

---

## 5. Сводная матрица Track 2 (Архитектурный вердикт)

| Компонент Upstream | Версия | Статус совместимости | Требуемые изменения в плагине |
|---|---|---|---|
| `@earendil-works/pi-durable` | 1.3.0+ | **Полная совместимость** | Поднять версию до `^1.3.0` в `package.json`. |
| `@earendil-works/pi-coding-agent` | 1.3.0 | **Полная совместимость** | Поднять версию до `^1.3.0` в `package.json`. |
| `@earendil-works/pi-codemode` | 1.3.0 | **Полная совместимость** | Поднять версию до `^1.3.0` в `package.json`. |
| `@earendil-works/pi-ai` | 1.3.0 | **Полная совместимость** | Удалить временный костыль `sanitizeToolResultForAnthropic`. |
| `@earendil-works/chord` | 1.3.0 | **Полная совместимость** | Использовать нативный сабпас `@earendil-works/chord/output` при необходимости. |

**Итог исследования:** Upstream Pi 1.3.0 является стабильным, высококачественным релизом, закрывающим давние узкие места в работе с Anthropic, OpenAI GPT-6, Gemini 4, компакшном и памятью. Обновление плагина `bb-plugin-provider-pi-durable` до версии 1.3.0 рекомендовано к немедленному включению в рабочий план Cycle 93.
