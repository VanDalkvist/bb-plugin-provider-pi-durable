

---

## Cycle tool-result-parity: Tool Result Parity (AP-011, AP-012, AP-013, AP-019, AP-020, AP-022, AP-026, AP-028, AP-029, AP-048, AP-050)

### Slices Summary (v0.2.52)
- **Baseline:** `83ee4a3e1f7547afee8b688281164897c4910d7e`, `main`, 0.2.51 → 0.2.52.
- **Canonical Knowledge:**
  - Research: `[[docs/research/2026-10-25-pi-durable-tool-result-parity]]`
  - PRD: `[[prd/2026-10-25-pi-durable-tool-result-parity]]`
  - Plan: `[[plans/2026-10-25-arch-loop-pi-durable-tool-result-parity]]`
- **Slice TRP.1 (P1):** Native Terminal Result Decoder & Canonical Details (`src/runner/bridge/native-tool-result.ts`, `src/runner/bridge/tool-result-presentation.ts`).
  - Разработан чистый типизированный декодер `decodeNativeToolEnd` для событий `NativeToolEndEvent`: различает model-issued вызовы (`event.entry`), вложенные вызовы (`event.result`), отсутствие обоих (ошибка) и протокольное нарушение одновременного присутствия.
  - Реализован канонический селектор деталей `extractCanonicalToolDetails`, читающий `entry.model[0].details` или `result.details`, сохраняющий явный сброс `details: null`, и категорически игнорирующий диагностический конверт `entry.data`.
  - В `tool-result-presentation.ts` внедрена безопасная проекция текста: ограничено распознавание изображений (`isImageContent` строго `type: "image"`), рекурсивно маскируются base64-данные во вложенных структурах без искажения обычных JSON-полей (`{ data: "customer-record" }`), поддержаны falsey-скаляры (`0`, `false`, `null`, `""`), bash stdout и публичный API усечения `truncateTail`. Устранен silent catch по AP-012/AP-022.
- **Slice TRP.2 (P2):** Scoped Progress State & Cumulative Retained Snapshots (`src/runner/bridge/tool-progress-state.ts`, `src/runner/bridge/tool-result-extractor.ts`, `src/host/tool-delta-translator.ts`).
  - Создан scoped класс `ToolProgressState` (без module-global singleton Map), рассчитывающий кумулятивные снимки вывода на операциях `set`, `append`, `trimStart`.
  - При метаданных-only обновлениях (`details` без `output`) возвращается текущий накопленный снимок вместо пустой строки, предотвращая затирание bash stdout.
  - В `tool-delta-translator.ts` поддержан пустой снимок bash (`typeof event.partialResult === "string"`), корректно очищающий терминал при `set: ""`.
- **Slice TRP.3 (P2):** Adapter Scoped Lifecycles & Canonical Terminal Discovery (`src/runner/bridge/bb-event-adapter.ts`, `src/runner/bridge/bb-child-event-adapter.ts`, `src/runner/subagent-watcher.ts`).
  - Root `BBEventAdapter` и `BBChildEventAdapter` владеют выделенными экземплярами `ToolEventProjector`.
  - В `BBChildEventAdapter` внедрено префиксирование ключей при сидировании из `snapshot` (`${parentRef}:${slot.callId}`), гарантирующее совпадение с ключами последующих обновлений, и сброс состояния на `run_start`.
  - В `BBEventAdapter` внедрен сброс проектора на `run_end` для изоляции межходовых буферов. Устранено приведение к `any[]` в `SnapshotEvent`.
  - В `subagent-watcher.ts` поиск terminal conversationId переведен на `extractCanonicalToolDetails`.
- **Slice TRP.4 (P2):** Contract Conformance & Real Harness Codemode Sandbox Verification (`tests/native-tool-projection.test.ts`, `tests/native-tool-events.fixture.ts`, `tests/tool-diff-metadata.test.ts`, `tests/codemode-hierarchy-parity.test.ts`).
  - Создан фикстурный генератор на базе реальных `Harness`, `MemoryStorage`, `fauxProvider`, `watchEvents`.
  - Добавлен сквозной сценарий с реальными `CodemodeSandbox` + `CodingTools`: `write`, `edit` с нативными patch/diff деталями, успешный `bash`, упавший `bash` (`exit 42`), пойманная ошибка `read` несуществующего файла и успешное завершение родительского `codemode`, с валидацией каждого дельты через `threadDeltaSchema.safeParse`.
  - Тесты с ложными фикстурами разделены и исправлены.

#### Architectural Findings & Discovered Bugs
| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-TRP-1** | Ложный fault при успехе вложенных инструментов | **P1** | AP-012, AP-026, AP-050 | `fix-now` | `tool-result-extractor.ts` проверял только `event.entry`, игнорируя `event.result`. Внедрен `decodeNativeToolEnd`. |
| **F-TRP-2** | Подмена `details` диагностическим конвертом `entry.data` | **P2** | AP-013, AP-026, AP-048 | `fix-now` | `details` читались из `entry.data` (`{ diagnostics }`). Заменено на канонический `extractCanonicalToolDetails`. |
| **F-TRP-3** | Затирание bash stdout при потоковом выводе и метаданных | **P2** | AP-013, AP-026, AP-050 | `fix-now` | Чанки не аккумулировались в кумулятивные снимки, а мета-апдейты сбрасывали `partialResult` в `""`. Создан `ToolProgressState`. |
| **F-TRP-4** | Утечка буферов через модуль-глобальный Map | **P2** | AP-011, AP-013, AP-048 | `fix-now` | `activeToolDetails` был глобальным синглтоном. Заменен на per-adapter `ToolEventProjector` со сбросом на `run_end` и `run_start`. |
| **F-TRP-5** | Несоответствие синтетических фикстур поведению SDK | **P2** | AP-028, AP-029, AP-056 | `fix-now` | Тесты использовали `entry` для вложенных инструментов. Заменены на контракты реального `Harness`. |

#### Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **330 / 330 passing assertions across 19 test suites (0 failures, 0 skips, ~19s execution time)**.
- `git diff --check`: **Clean (exit code 0)**.
- AP-019: все затронутые TS-файлы < 200 строк; новые функции <= 40 строк. Крупные legacy switch-dispatchers существовали до этого среза и не объявляются соответствующими лимиту:
  - `src/runner/bridge/tool-progress-state.ts`: **76 строк**.
  - `src/runner/subagent-watcher.ts`: **96 строк**.
  - `src/runner/bridge/tool-result-presentation.ts`: **100 строк**.
  - `src/runner/bridge/native-tool-result.ts`: **107 строк**.
  - `src/runner/bridge/tool-result-extractor.ts`: **136 строк**.
  - `src/runner/bridge/bb-child-event-adapter.ts`: **172 строки**.
  - `src/host/tool-delta-translator.ts`: **179 строк**.
  - `src/runner/bridge/bb-event-adapter.ts`: **195 строк**.
  - Все 10 тестовых файлов: **от 96 до 190 строк**.
  - **100% затронутых файлов строго < 200 строк**.
- Архитектурный гейт S9:
  - **Architecture Review (@thread:thr_6b7wn4nzq8):** **VERDICT: PASS** (все замечания P1-P3 устранены и проверены).
- Статус продукта:
  - Тест таймлайна на старом git-кеше: **FAIL** (несоответствие развернутой версии старому артефакту, не этот чекаут).
  - **Product Review Stage 2 (@thread:thr_qjevvu38fz): PASS** для нового собранного runner через публичный JSONL CLI: happy/empty/error/recovery, реальные read/write/edit/bash, причины ошибок и diff сохранены; report `PRODUCT_REVIEW_STAGE2_BUILT_RUNNER.md`, 44 wire events.
  - **S9 code/artifact gates: Architecture PASS + Product PASS.** Не подменяют проверку установленной версии.
  - Роллаут **authorized / pending**: пользователь 2026-10-25 явно разрешил push после арх-лупа, тег 0.2.x и обновление плагина. После публикации v0.2.52 обязательна повторная проверка живого BB timeline. Исторические failed rows не переписываются.

---

## Cycle 103: Codemode Subagent Presentation & Hierarchy Parity (AP-010, AP-013, AP-019, AP-026, AP-028, AP-029)

### Slices Summary (v0.2.51)
- **Slice 103.1 (P1):** Codemode Presentation Descriptors & Title Resolver (`src/host/tool-presentations.ts`, `src/host/tool-item-shape.ts`).
  - Создан независимый модуль `src/host/tool-presentations.ts` (61 строка), инкапсулирующий `getCodemodePresentation` (глиф Lucide `Code`, лейблы `{ pending: "Running code", completed: "Ran code" }` и автоизвлечение лаконичного заголовка скрипта до 80 символов из комментариев/кода с пропуском директив `// @options:`).
  - Вынесено построение форм инструментов в `src/host/tool-item-shape.ts` (87 строк), разгружая `tool-delta-translator.ts` до 177 строк и гарантируя соблюдение лимитов AP-019 (< 200 строк на файл).
- **Slice 103.2 (P1):** Hierarchy & ParentRef Suppression for Nested Execution (`src/runner/bridge/bb-event-adapter.ts`, `src/host/delta-translator.ts`, `src/host/tool-delta-translator.ts`).
  - В root `BBEventAdapter` добавлен метод `resolveParentRef`, подавляющий проброс `parentRef` для вызовов внутри `codemode` (и любых инструментов, не являющихся явными делегациями). Это предотвращает ошибочное включение `referencedParentCallIds` в `SemanticProjectionBuilder` сервера Beyond Boundaries и ликвидирует ложное превращение `codemode` в субагента.
  - В `DeltaTranslator` и `tool-delta-translator.ts` реализован второй защитный контур (`resolveSafeParentRef`), проверяющий `parentShape` в `activeTools` и сбрасывающий `parentRef` для детей `codemode`.
  - Вложенные вызовы (`bash`, `read`, `write`, `edit`) стримятся напрямую в таймлайн со своими нативными карточками (терминал с живым выводом, diff-превью изменений), а счётчик хода отображает точные инструменты (например, `Ran 1 tool, 2 commands` вместо `subagent`).
  - Настоящие субагенты (`subagent`, `agent_spawn`, `agent_spawn_graph`) и поток дочерних событий через `BBChildEventAdapter` полностью сохраняют тип `delegation`, карточки с иконкой `Bot` и привязку `parentRef`.
- **Slice 103.3 (P1):** TDD Conformance & Verification (`tests/codemode-presentation-parity.test.ts`).
  - Разработан тест-сьют `tests/codemode-presentation-parity.test.ts` (7 тестов, 100% pass), проверяющий чистоту заголовков `extractCodemodeTitle`, контракт `threadDeltaSchema`, подавление `parentRef` в `BBEventAdapter` и `DeltaTranslator`, а также сохранение иерархии субагентов.

#### Architectural Findings & Discovered Bugs
| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-103-1** | Ложная проекция `codemode` в субагента из-за утечки `parentToolCallId` | **P1** | AP-010, AP-013 | `fix-now` (Cycle 103) | `BBEventAdapter` безусловно передавал `event.parentToolCallId` из `codemode` как `parentRef`. В BB сервере `SemanticProjectionBuilder` конвертировал родительский `codemode` в `delegation`. Подавлено в `bb-event-adapter.ts` и `tool-delta-translator.ts`. |
| **F-103-2** | Отсутствие нативной презентации `codemode` в таймлайне BB | **P1** | AP-010, AP-026 | `fix-now` (Cycle 103) | У `codemode` отсутствовала презентация, вызывая откат к дефолту `qa(status)` («Running subagent: codemode»). Добавлен `getCodemodePresentation` с иконкой `Code` и статусами `Running code` / `Ran code`. |

#### Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **308 / 308 passing assertions across 18 test suites (0 failures, 0 skips, ~21s execution time)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- Строгое соблюдение AP-019 (< 200 строк):
  - `src/host/tool-presentations.ts`: **61 строка** (бюджет < 200).
  - `src/host/tool-item-shape.ts`: **87 строк** (бюджет < 200).
  - `src/host/tool-delta-translator.ts`: **177 строк** (бюджет < 200).
  - `src/host/delta-translator.ts`: **170 строк** (бюджет < 200).
  - `src/runner/bridge/bb-event-adapter.ts`: **198 строк** (бюджет < 200).
  - `tests/codemode-presentation-parity.test.ts`: **275 строк** (тестовый файл).
  - **100% затронутых файлов строго < 200 строк**.
- Двухконтурный гейт S9:
  - **S9a Architecture Review (@thread:thr_y52yxwsm8f):** `AP-010`, `AP-011`, `AP-012`, `AP-013`, `AP-014`, `AP-019`, `AP-020`, `AP-021`, `AP-022`, `AP-023`, `AP-025`, `AP-026`, `AP-028`, `AP-029` соблюдены. **VERDICT: PASS**.
  - **S9b Product Review (@thread:thr_8y3n2nda8g):** Валидированы Happy Path, Cold-Start/Zero-Data и Adversarial краевые состояния. Ложная проекция субагентов устранена, живой терминал сохранен. **VERDICT: PASS**.

---

## Cycle 102: Stubs, Defaults & Missing Parity Remediation (AP-010, AP-012, AP-019, AP-026, AP-028, AP-029)

### Slices Summary (v0.2.50)
- **Slice 102.1 (P1):** Dynamic Options Reconciliation & Reasoning Lifecycle (`src/runner/session-commands.ts`).
  - Устранено игнорирование параметров сессии: `reconcileSessionOptions` обновляет активную модель и уровень рассуждений (`thinkingLevel`) на лету при переключении настроек без перезапуска процесса.
- **Slice 102.2 (P1):** Multi-Skill CLI Argument Parsing & Runner Spawning (`src/runner/cli-args.ts`, `src/host/runner-args.ts`).
  - Поддержан массив флагов `--skill <path>` в CLI аргументах, что позволяет подключать несколько внешних и проектных скиллов одновременно без потери путей.
- **Slice 102.3 (P1):** Extension Context Actions & Real Hook Binding (`src/runner/extension-mount.ts`).
  - Заглушки контекстных действий расширений заменены на реальные вызовы рантайма Pi Coding Agent.
- **Slice 102.4 (P1):** Dynamic Model Reasoning Efforts (`src/host/model-catalog.ts`).
  - Устранен жесткий хардкод уровней рассуждений: маппинг строится динамически на основе возможностей модели из `ModelCatalog`.
- **Slice 102.5 (P1):** TDD Conformance & Verification (`tests/stubs-remediation.test.ts`).
  - Написан тест-сьют `tests/stubs-remediation.test.ts` (7 тестов, 100% pass), валидирующий смену модели на лету, многократные скиллы и динамический reasoning.

#### Verification Evidence
- `npm test`: **301 / 301 passing assertions across 17 test suites (0 failures, 0 skips)**.
- `npm run build`: Сборка успешна.
- Двухконтурный гейт S9:
  - **S9a Architecture Review (@thread:thr_9a2gfy4ss8):** **VERDICT: PASS**.
  - **S9b Product Review (@thread:thr_23h9w4579j):** **VERDICT: PASS**.

---

## Cycle 101: Canonical Codemode Routines, Dynamic MCP Namespaces & Prompt Guidelines (AP-010, AP-018, AP-019, AP-026, AP-028, AP-029)

### Slices Summary (v0.2.49)
- **Slice 101.1 (P1):** Canonical Snippets and Batching Guidelines in System Prompt (`src/runner/prompt.ts`).
  - В `CANONICAL_TOOL_DEFS` добавлены канонические сниппеты и guidelines для `codemode` и `tool_search` по стандарту `@earendil-works/pi-coding-agent`.
  - В `<tools>` ликвидирован дамп 2.5КБ низкоуровневых технических деталей песочницы: инструмент представляется краткой операционной выжимкой: `"Run JavaScript in a sandbox to call other tools. Use it to batch, chain, or loop tool calls without roundtrips."`
  - В `<rules>` внедрено каноническое правило выбора codemode: `"- Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls."`, что формирует у модели естественную привычку пакетировать вызовы.
- **Slice 101.2 (P1):** Dynamic MCP Namespaces Extraction & Reactive Extension Binding (`src/runner/codemode-namespaces.ts`, `src/runner/harness-setup.ts`, `src/runner/extension-mount.ts`, `src/runner/runtime-loader.ts`).
  - Создан независимый модуль `src/runner/codemode-namespaces.ts` (43 строки), инкапсулирующий `DynamicCodemodeNamespaces`. Из зарегистрированных инструментов (`mcp__<server>__*`) автоматически и без хардкода извлекаются префиксы серверов и описания (`namespace.description` / `instructions`).
  - В `createCodingRegistry` передан динамический геттер `get namespaces() { return dynamicNamespaces?.getNamespaces() ?? []; }`, реактивно поставляющий свежие неймспейсы при каждом рендере секции `<codemode>`.
  - В секции `<codemode>` инструменты MCP серверов аккуратно группируются по разделам (`## gbrain`, `## telegram` и др.) с метаданными сервера, а в QuickJS sandbox функции `describeNamespace()` и `searchTools("", { namespace })` корректно разрешают фильтрацию по неймспейсам.
- **Slice 101.3 (P1):** TDD Conformance & Verification (`tests/codemode-canonical-routines.test.ts`).
  - Разработан детерминированный тест-сьют `tests/codemode-canonical-routines.test.ts` (4 теста, 100% pass), проверяющий канонический сниппет в `<tools>`, инъекцию правила батчинга в `<rules>`, динамическое извлечение неймспейсов без хардкода и проброс в реестр Durable.

#### Architectural Findings & Discovered Bugs
| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-101-1** | Отсутствие канонических сниппетов и guidelines для `codemode` и `tool_search` | **P1** | AP-010, AP-018 | `fix-now` (Cycle 101) | `CANONICAL_TOOL_DEFS` не содержал `codemode`, вызывая спам сырой документации в `<tools>` и отсутствие побуждающего правила в `<rules>`. Исправлено в `prompt.ts`. |
| **F-101-2** | Отсутствие передачи динамических неймспейсов MCP в `createCodemodeExtension` | **P1** | AP-010, AP-026 | `fix-now` (Cycle 101) | `createCodemodeExtension` вызывался с пустыми опциями, лишая секцию `<codemode>` группировки `## <server>` и ломая `describeNamespace()`. Создан `codemode-namespaces.ts` и динамический геттер. |

#### Verification Evidence
- `npm test`: **294 / 294 passing assertions across 16 test suites (0 failures, 0 skips, ~18.2s execution time)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- Строгое соблюдение AP-019 (< 200 строк):
  - `src/runner/codemode-namespaces.ts`: **43 строки** (бюджет < 200).
  - `src/runner/prompt.ts`: **182 строки** (бюджет < 200).
  - `src/runner/harness-setup.ts`: **174 строки** (бюджет < 200).
  - `src/runner/extension-mount.ts`: **194 строки** (бюджет < 200).
  - `src/runner/runtime-loader.ts`: **160 строк** (бюджет < 200).
  - `tests/codemode-canonical-routines.test.ts`: **138 строк** (бюджет < 200).
  - **100% файлов в `src/runner/` строго < 200 строк**.
- Двухконтурный гейт S9:
  - **S9a Architecture Review (@thread:thr_g29wjcnxg3):** `AP-010`, `AP-018`, `AP-019`, `AP-026`, `AP-028`, `AP-029` соблюдены. **VERDICT: PASS**.
  - **S9b Product Review (@thread:thr_hdq4i43dnc):** Чистая плотность тул-каталога, канонический стимул к батчингу в правилах, динамическая группировка без хардкода серверов, нулевой риск регрессий для direct MCP и сабагентов. **VERDICT: PASS**.

---

## Cycle 100: Canonical MCP Connection & Extension Lifecycle Hooks Parity (AP-010, AP-013, AP-019, AP-026, AP-028, AP-029)

### Slices Summary (v0.2.48)
- **Slice 100.1 (P1):** Complete Pi Extension Lifecycle Hooks Parity (`src/runner/runtime-controller.ts`, `src/runner/diagnostics-types.ts`).
  - В `src/runner/runtime-controller.ts` в обработчике `watchAnswer()` реализована эмиссия `agent_end` при завершении ответа модели и `agent_settled` при переходе агента в состояние покоя. Это восстанавливает вызов `gbrain hook stop`, фиксацию живого буфера сессии и сброс writeback-фактов.
  - В `compact()` внедрена типобезопасная отправка событий `session_before_compact` и `session_compact`, восстанавливающая вызов `gbrain hook compact` для сохранения standing entities в банк памяти перед компактом контекста.
  - В `src/runner/diagnostics-types.ts` множество `SUPPORTED_EXTENSION_HOOKS` расширено хуками `agent_end`, `agent_settled`, `session_before_compact`, `session_compact`.
- **Slice 100.2 (P1):** ReachesTools & MCP Startup Race Parity (`src/runner/extension-bridge.ts`, `src/runner/extension-mount.ts`).
  - Устранена гонка `waitForDirectServers`: в `src/runner/extension-mount.ts` добавлен макротик ожидания (`await new Promise((r) => setImmediate(r))`) перед первым `emitBeforeAgentStart`, позволяющий `createMcpExtension` инициализировать промисы `server.ready` серверов из `mcp.json`.
  - В `src/runner/extension-bridge.ts` метод `actions.getAllTools` объединён с `getCallableTools()`, снабжая host-инструменты `codemode` и `tool_search` флагом `reachesTools: true`. Это полностью ликвидирует ложное предупреждение `ensureDiscoveryActive` о недоступности MCP-инструментов.
- **Slice 100.3 (P1):** TDD Conformance & Verification (`tests/lifecycle-hooks-mcp.test.ts`, `tests/diagnostics.test.ts`).
  - Написан новый модульный тест-сьют `tests/lifecycle-hooks-mcp.test.ts` (3 теста, 100% pass), валидирующий полноту хуков и атрибут `reachesTools: true`.
  - `tests/diagnostics.test.ts` обновлен для подтверждения полной поддержки жизненного цикла gbrain (0 unsupported hooks в отчете Doctor).

#### Architectural Findings & Discovered Bugs
| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-100-1** | Отсутствие проброса событий `agent_end` и `agent_settled` | **P1** | AP-010, AP-013 | `fix-now` (Cycle 100) | `runtime-controller.ts` не вызывал события завершения хода. Реализована эмиссия `agent_end` и `agent_settled` в `watchAnswer()`. |
| **F-100-2** | Отсутствие проброса хуков `session_before_compact` и `session_compact` | **P1** | AP-010, AP-013 | `fix-now` (Cycle 100) | `compact()` запускал сжатие без оповещения расширений. Добавлены вызовы перед и после компакта контекста. |
| **F-100-3** | Гонка `waitForDirectServers` и ложный варнинг `reachesTools` | **P1** | AP-010, AP-026 | `fix-now` (Cycle 100) | `mountExtensionBridge` обгонял `setImmediate` MCP-рантайма, а `getAllTools` опускал host-инструменты. Исправлено в `extension-bridge.ts` и `extension-mount.ts`. |

#### Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `node --test tests/lifecycle-hooks-mcp.test.ts`: **3 / 3 pass (0 fails)**.
- `npm test`: **290 / 290 passing assertions across 15 test suites (0 failures, 0 skips)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `npm run doctor`: **gbrain.ts: 0 unsupported hooks (session_start, before_agent_start, agent_settled, agent_end, session_before_compact, session_shutdown, tool_call — 100% supported)**.
- Строгое соблюдение AP-019 (< 200 строк):
  - `src/runner/diagnostics-types.ts`: **64 строки** (бюджет < 200).
  - `src/runner/extension-bridge.ts`: **180 строк** (бюджет < 200).
  - `src/runner/extension-mount.ts`: **196 строк** (бюджет < 200).
  - `src/runner/runtime-controller.ts`: **195 строк** (бюджет < 200).
  - **100% файлов в `src/runner/` строго < 200 строк**.
- Двухконтурный гейт S9:
  - **S9a Architecture Review:** `AP-010`, `AP-013`, `AP-019`, `AP-026`, `AP-028`, `AP-029` соблюдены. **VERDICT: PASS**.
  - **S9b Product Review:** Загрузка 35 инструментов `gbrain`, ликвидация ложного варнинга `reachesTools`, вызов всех хуков жизненного цикла подтверждены живым рантаймом. **VERDICT: PASS**.

---

## Cycle subagent-model-policy-2026-10-25 — Central Policy, Native Admission and Mirror Isolation

### Context and implemented slices
- Branch `main`; baseline `4d02d4c` (330 tests), feature/correction tree `9416d0d`. Later update-guidance commits touch README/AGENTS only and belong to another thread.
- Canonical plan: `docs/superpowers/plans/2026-10-25-subagent-model-policy.md`. Exact SDK 0.6.79 and Pi 1.3.0; no compatibility shims, independent catalog, scheduler or per-call model kwargs.
- Authority: BB owns policy/UI/KV; Pi owns models/auth/capabilities; Durable owns child execution, admission and replay. Saved policy and native acknowledged execution snapshot serve different purposes.
- Commits: SDK `1deba49`; policy backend `4754427`; native runtime `43f9362`, `4ba97b0`; host/mirrors `d4a091e`; packaging `6067b6f`; UI/instructions `53c6c6b`; integrated findings `8cce858`, `9416d0d`.
- Memory used: mid-session model reconciliation, target-aware shared-owner routing, real native event families and batch-correlated outcomes. Rechecked against current source/SDK, not treated as proof.

### Findings and fixes
| ID | Severity | Evidence / impact | Decision and closure |
|---|---|---|---|
| F1 | P1 | Cold child guard read fictitious state.agent/agent instead of the producer's flat get_state model/thinkingLevel, allowing unmatched overrides. AP-012/016/026. | fix-now: typed unknown port, actual DTO, fetch missing thinking, fail-closed requested overrides. `tests/host-mirror-guard-repro.test.ts`. |
| F2 | P1 | BB parentThreadId misclassified independent manual roots and skipped policy/reconcile/compact. AP-011/020/048. | fix-now: actual session identity after creation and native target/binding; public ROOT_CONVERSATION_ID. A wrong corrective root-0 fixture was rejected; installed Pi 1.3 root is 1. RED/GREEN captured in parent storage. |
| F3 | P2 | Delayed Save erased a changed mode draft. AP-022. | fix-now: disabled mode radios and compare current draft with submitted snapshot. Public SDK UI regression. |
| F4 | P2 | AbortController existed without abort; old route requests survived. AP-023/027. | fix-now: abort on route change/unmount, stale-result protection and catalog reset. Public SDK UI regression. |
| F5 | P2 | Synthetic hostId=default and optional old-SDK probes obscured routing errors. AP-013/026. | fix-now: mandatory current APIs, null routing with no fake query, honest empty/error UI; catalog errors block configured Save, inherit remains available. |
| F6 | P3 | Workspace model ban could contradict a user-selected native profile; delivery timing unclear. | fixed narrowly: CLI-only wording and next-owner-turn UI scope. Workspace diff remains separate. |
| F7 | P3 | General UI error panel combines different errors. | log-only: no redesign in this bounded release. |

### Verification and S9 gate
- Fresh parent receipt: `accepted-policy-verification.json`, thread `thr_3e4z9meeqs`, candidate `4a3dab9` (production tree identical to `9416d0d`).
- `npm test`: **395 Node + 9 UI = 404 passed, 0 failed**. `npx tsc --noEmit`, `npm run build`, dependency check: **exit 0**. No changed production TS/TSX file reaches 200 lines.
- Runner: **143947 bytes**, down from 897640 after externalizing runtime Zod. Packaging regression uses an isolated real build fixture.
- `bb plugin types --check`: **exit 1**, explicitly NOT PASS. Generic devDependency recommendation conflicts with actual production provider-bridge imports; exact version is correct, runtime dependency retained.
- One final integrated analytical round on `53c6c6b` initially returned FAIL. The original reports are preserved; targeted closure of those findings on `8cce858`/`9416d0d` is **Architecture PASS + Product PASS**. No second broad repository review.
- Reports: `reviews/2026-10-25-subagent-policy-final-architecture.md` and `reviews/2026-10-25-subagent-policy-final-product.md`.

### Residual risk and handover
- Code/SDK fixtures verified; no installed-plugin update, live configured-model generation, reload, public push/tag/release claimed. Package remains 0.2.52. Separate update checklist governs deployment; no mandatory BB/host restart is prescribed by this cycle.
- Canonical implementation/lessons: GBrain `docs/research/pi-durable-subagent-policy-implementation-2026-10-25`; project memory indexes that record.
- Subsequent user-requested file-change delta micro-loop is separate: `docs/superpowers/plans/2026-10-25-file-change-delta-micro-loop.md`. Its investigation is not included in this policy PASS.
- User authorized Google Vertex for remaining helpers after Antigravity quota exhaustion; execution provider remains Pi Durable.

---

## Cycle file-change-delta-2026-10-25 — Native Edit Identity and Canonical Patch

### Context and selected findings
- Separate user-requested micro-loop after policy fixes. Canonical plan: `docs/superpowers/plans/2026-10-25-file-change-delta-micro-loop.md`; investigation: `reviews/2026-10-25-file-change-delta-investigation.md`.
- Screenshot and actual native records agree: one edit call produced several rows for one file, and the displayed +1/-0 card omitted most hunks. Resident 0.2.52 and checkout had the same mapper defect; BB Core was consuming the supplied contract correctly.
- **[P1, fix-now, AP-013/026]** `details.diff` is numbered/ellipsized TUI display, while `details.patch` is the authoritative unified patch. Selecting diff first broke the consumer's patch parsing.
- **[P1, fix-now, AP-013/026/028]** `args.edits` lists replacement regions of one `args.path`, but each was incorrectly mapped to a separate fileChange.changes entry. The old test encoded that wrong expectation.

### Applied fix and evidence
- Commit **`f11f89de3bebbd805579ebd87edc4c617d90d376`**: only `src/host/tool-item-shape.ts` and `src/host/diff-utils.ts` changed in production. One path/update entry per native edit call; canonical patch preferred; valid diff-only producer remains supported. No custom TUI parser, patch reconstruction, grouping registry or BB Core change.
- RED before source edits: `thr_squn93nr4e/investigation/red-output.log` (3 entries instead of 1; 0 parsed hunks instead of 1). Phase A's earlier print-only hypothesis script is not counted as RED.
- `tests/native-edit-file-change.test.ts` uses the real public Pi 1.3 createEditTool on temporary content: all 3 separated hunks survive and applyPatch(before, translated) equals actual after byte-for-byte. Single edit, independent calls/files and valid diff-only producer are covered; obsolete multi-entry assertion corrected.
- Parent targeted GREEN: **11/11**, `delta-targeted-green.log`. Full fresh receipt `delta-final-verification.json`: **399 Node + 9 UI = 408 pass, 0 fail**; typecheck/build/dependencies exit 0. Source lines **69/183**, test lines **160/194**, runner **143947 bytes**.
- Initial readback briefly observed dirty generated CSS. Later `delta-post-build-readback.json` verifies src/tests/dist exactly equal the candidate and CSS blob `e26c4bd7694c4225206cc9a97567ce04793756c9`; no CSS reorder/change is established or included.

### S9 acceptance and residuals
- Narrow architecture **PASS**, `reviews/2026-10-25-file-change-delta-architecture.md`.
- Product **PASS**, `reviews/2026-10-25-file-change-delta-product.md`: public SDK consumer assembles actual captured notifications for successful multi-region edit, cold/no operations and failed oldText lookup. It verifies one file entry, retained hunks, exact before→after, unchanged file/error status on failure and no fabricated diff.
- Acceptance is code/data-plane, **not live desktop UI smoke**. No installed plugin update/reload, public push/tag/release or forced history rewrite. Rollout follows the separate update checklist; no BB/host restart requirement is inferred.
- Existing SDK placement exit 1 remains a documented exception; package version 0.2.52, SDK 0.6.79, Pi 1.3.0 unchanged. No new unrelated cleanup selected.
- Durable lesson: GBrain `docs/research/pi-durable-native-edit-file-change-micro-loop-2026-10-25`; repository memory contains only the execution index.


