

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

---

## Integrated pre-1.4 remediation — Cycle 104/105 handoff, 2026-10-25

### Context and authority
- Source handoff: `HANDOFF-PIDURABLE-104-105-BEFORE-1.4`, thr_q5zsegjn7j → thr_ct3kk9xne6. Sender performed review/design only at **83ee4a3 / 0.2.51**, no source/test/package implementation. Its parallel cycle stops; integration/execution belongs to the existing 1.4 loop.
- Canonical accepted inventory: GBrain `docs/arch-improvement/pi-durable-cycle-105-remediation-design-2026-10-25`; proposal.md overrides its older detailed draft. Historical 308/308 is not current evidence.
- Current reconciliation: **7d0b5b83258958eaa2e6c8b725ef0e779c0ecce1 / 0.2.53 / Pi 1.3.0 / SDK 0.6.79**; src/tests unchanged from ee18035 while another authorized release updated metadata. No competing feature work staged by this integration.
- Execution plan and full traceability/design: [R0–R6](../superpowers/plans/2026-10-25-durable-1.4-boundary-remediation.md); master updated. All **4 P2 + 7 P3** included before 1.4 cutover. Latest user request: execute economically, defer architecture/product reviewers until all implementation steps, final 0.2.x bump + push main; no implicit installation/restart.

### Reconciled findings and decisions
- [P2] F-104-1 IPC contract/decoder — **fix-now R1**. Evidence: runner-rpc-channel.ts:27/33/50 casts/raw-line logs; host/types.ts independent open RunnerEvent. Impact: malformed boundary data/correlation risk. Rule: AP-026/029/024.
- [P2] F-104-2 import SCC — **fix-now R0**. Evidence: current SCC now includes session-state-commands and actual value parseConversationId edge. Impact: coupled contract ownership, not proven deadlock. Rule: AP-025.
- [P2] F-104-3 size/owners — **partial, fix-now R2/R3**. Evidence: session.ts now 180 lines and has semantic handler extraction; message-delta-translator remains 249. Impact: remaining responsibilities/budget violation. Rule: AP-018/019. Do not claim old 240-line session is still present.
- [P2] F-104-4 compact hook observability — **fix-now R3**. Evidence: runtime-controller.ts:105/128 still suppress context/hook errors. Impact: best-effort failures disappear. Rule: AP-022/023.
- [P3] P3-1 prompt/steer DTO — **fix-now R2**; current imagesOrConversationId overload/router ternaries. Rule: AP-026.
- [P3] P3-2 mirror adoption owner — **fix-now R2**; router:69–106 still owns consume/register/completion policy; existing child guard does not close it. Rule: AP-020/021.
- [P3] P3-3 four typed fixture seams — **fix-now R5**; no test compiler project, legacy partial casts remain. Rule: AP-026/028/029. No meaningless global any rewrite.
- [P3] P3-4 diagnostics/title locality — **fix-now R4**; diagnostics still imports host from runner, title shared from runner. Rule: AP-018/020/025. No false process-isolation claim.
- [P3] P3-5 direct type imports — **partial, fix-now R4**; task-graph-bridge is correct, six bridge/watcher imports and index still pass through runtime.ts. Rule: AP-025.
- [P3] P3-6 runtime state/subscription owner — **fix-now R3**; independent getter/setter context remains. Rule: AP-011/018/023.
- [P3] P3-7 diagnostics_get schema (additional) — **fix-now R4**; active RPC still z.custom report. Rule: AP-026/029. Preserve working Doctor/UI.

### Fresh baseline verification — not remediation acceptance
- `npm test`: **399 Node + 9 UI = 408 passed**, 0 fail/skip/cancel; source `tsc --noEmit`: exit 0. Receipt files in `thr_ct3kk9xne6/handoff-104-105-{npm-test.log,tsc.log}`.
- Read-only TypeScript AST inventory: **89 src files / 207 static edges**, SCC binding-commands/session-commands/session-state-commands; value SCC session-commands/session-state-commands. Only source over strict <200 budget: message-delta-translator.ts **249**. Source session/router/controller: **180/196/198**. Metrics and audit script in same thread storage.
- No 1.4 source upgrade, new feature tests, post-fix type-test project/build or independent product/architecture PASS is claimed at this integration checkpoint. All eleven items await actual RED/GREEN closure; upstream 1.4 does not automatically replace adapter-owned boundaries.

### Preserved contracts / residual risk
- Keep real response wire `{id,type:'response',command,success,data/error}`, native root/child identity and model/reasoning policy; unknown-type vs known-invalid dispositions explicit; no raw payload/secret logs or guessed parent failure.
- Keep existing real SDK SQLite regression, native-edit canonical patch and early/late mirror completion fixes; no revival of rejected DDL/complexity/import-count claims.
- Current production provider remains separate from this checkout. User manual no-mandatory-backup path stays in force; no source-switch/remove/reload/quit/kill or original SQLite open is implied by this record.
- Architecture verification at integration checkpoint: AP-019/025/026/029/022 remained open; final dual-circuit review is **NOT RUN**. Planning inventory coverage was 11/11, not code PASS.

### Implementation checkpoint R0–R4 (before dependency upgrade)
- R0 committed **3325275**: command contracts and conversation-id parser separated; actual 3-node SCC RED → zero SCC GREEN; focused 8/8 and source typecheck.
- R1: shared schema-inferred wire/command/response/channel contracts, bounded parsing and diagnostics; matching request ID AND command, unknown-type skip vs known-invalid quarantine; pending RPCs reject explicitly; public `provider.warning` records observation failure without manufacturing parent/child task outcomes. Genuine protocol/privacy/correlation RED receipts and isolated fake child-process proof; focused runner tests 32/32, earlier full suite 413 Node + 9 UI before subsequent slices. No protocol wrapper replacement.
- R2: explicit prompt/steer object DTO and all actual callers migrated; pure mirror adoption with four-operation port, authoritative terminal-flush result instead of mutating transport notification context; reasoning has its own owner. Message source budget 249 → 175; all src TS below 200. Actual DTO/budget RED → GREEN; old early/late/buffer/child isolation fixtures updated to the new public contract, not loosened.
- R3: private conversation/task binding owner with acquisition-before-replacement, epoch suppression of late callbacks, idempotent close and failed-acquisition disposal. Runtime teardown attempts all resources in order. Compact context/hook rejection has typed causal best-effort warnings; native compact success is not revoked. Focused lifetime/hooks checks **11/11**, source typecheck and zero SCC. Existing legacy compact hook payload adaptation casts are NOT silently claimed fixed by this observability change; R5 must record their exact boundary/risk.
- R4: diagnostics implementation relocated to Host; pure shared title; direct runtime-types imports and removed composition-root type re-exports. Real nested diagnostics report schema is enforced by active RPC (Standard Schema success/failure tested), not z.custom. Focused **12/12**, source typecheck/AST pass.
- Corrected old UI claim using source history: policy commit **53c6c6b / Task8** explicitly replaced old Doctor prototype with subagent settings. The 0.2.51 manifest did not register bb.app; current active frontend is the approved settings section. No prototype restoration or deletion of RPC/catalog/doctor CLI is part of this remediation.
- Fresh combined pre-pin run: **432 Node tests, 431 pass / 1 failing legacy mirror fixture**, then that fixture's missing new consume/register contract was fixed and its suite **5/5** passed. This is NOT reported as a fresh combined 432/432 run. New 1.4 manifest tests are now intentionally RED against 1.3 (`u1-version-red.log`).
- Remaining: R5 complete typed fixture/compiler migration and touched-test budgets, exact target 1.4 adaptation and re-verification, one final independent detailed Antigravity architecture/product round, final 0.2.x bump/push. No installed-plugin change, original-session migration, backup, restart, tag or marketplace release performed by this thread.

---

## Cycle durable-1.4-foundation-and-runtime-graph-backend — 2026-10-26

### Context and implemented slices
- Branch `main`; base `7d0b5b8` (0.2.53), commits `3325275` (R0) and `8103a38` (R1–R4).
- Target: Pi 1.4 cutover (exact 1.4.0 pins for `@earendil-works/pi-durable`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-codemode`, `@earendil-works/chord`, `@earendil-works/pi-ai`), SDK 0.6.79.
- Boundary remediation R0–R5 + U1/R6: typed boundary fixtures (`tsconfig.contract-tests.json`), negative contract compiler guard (`scripts/check-negative-contracts.mjs`), test splits keeping all touched TS/TSX strictly < 200 lines (AP-019).
- Foundation S9 Reviews: `reviews/2026-10-26-s9-architecture-1.4.md` (PASS) and `reviews/2026-10-26-s9-product-1.4.md` (PASS).
- Runtime Graph Backend (G1) & Admission Race (S8):
  - Read model: `src/runtime-graph/`, `src/runner/runtime-graph-*.ts`, debounced snapshots, scope filtering, receipts bounded to 128 entries.
  - Admission coordination: `src/host/session-admission.ts`, single writer mutex, fine-grained participant cancellation.
  - Independent S9 review initially reported 8 findings (4 P1, 4 P2) in `reviews/2026-10-26-s9-runtime-graph-backend.md` (historical FAIL).
  - Remediation applied and retested in `reviews/2026-10-26-s9-runtime-graph-backend-retest.md` (PASS).
- Integration Verification & Final Remediation:
  - Full integration test run identified 9 alias failures + 2 oversized test files recorded in `reviews/2026-10-26-integrated-verification.md` (historical FAIL).
  - Core cause: BB subthread child identity contract — child thread receives own `providerThreadId` alias, while composite IDs (`conversationId !== undefined`) require exact parent match; `turn/start` without `providerThreadId` must resolve bound identity rather than generate timestamp.
  - Fixes applied: `src/host/session-binding.ts` (`SessionBindingTracker`), `SessionRegistry.createOrGet`, `bridge-router.ts`, test splits (`tests/runtime-graph-source.scenarios-2.test.ts`, `tests/session-admission-race.scenarios-2.test.ts`).
  - Result verified in `reviews/2026-10-26-integration-regression-fix-result.md` (PASS).

### Verified Status of Milestones
- **Foundation Pi 1.4 + G1 (Runtime Graph Backend): VERIFIED**
  - Full test suite: **510 tests passed, 0 failed** (501 node:test + 9 UI tsx).
  - Source typecheck `npx tsc --noEmit`: exit 0.
  - Contract compiler & negative guard: exit 0 (actual TS2322 rejection confirmed).
  - Import AST graph: 123 source files, **0 cycles (Tarjan SCC)**.
  - File budgets (AP-019): **All touched and new TS/TSX files strictly < 200 lines**.
  - Dist build: `npm run build` exit 0, all artifacts current.
  - Dependency security: `npm audit` found 0 vulnerabilities; exact 1.4.0 pins for Pi ecosystem.
  - BB identity contract: Legitimate child has own alias `providerThreadId`; same-thread hostile replacement and foreign composite root forbidden; single writer and cancellation lifecycle preserved.
- **G2 (Public BB Event Transport): BLOCKED / unproven live roundtrip**
  - Event schemas and delta translation unit-tested, but real Electron desktop roundtrip is unproven in live harness.
- **G3 (UI Context Segment & Permission): PENDING**
  - Read-only UI projection primitives created in `src/ui/runtime-graph/`, but operator UI permission is pending. No UI component invented outside approved primitives.
- **Plan Status: INCOMPLETE (Backend Checkpoint Only)**
  - Entire plan is NOT complete. No package version bump, no tag, no marketplace release, no install/restart executed. Final 0.3.0 release (per 2026-10-26 amendment) deferred until G2/G3 and remaining gates are satisfied.

### Governing Release Amendment — 2026-10-26 (v0.3.0 Release Target & Tag Preservation)
- **Решение оператора:** «этот арх луп надо финалить под 0.3.0...много изменений ломающих поведение» (GBrain fact #1699).
- **Финальный релиз: 0.3.0 вместо 0.2.x.** Вследствие фундаментальных breaking behavior changes (Pi 1.4 foundation, проекция runtime task graph, координация admission race и селекторные привязки session bindings, централизованная subagent policy v1) итоговый релиз арх-лупа переориентирован на версию `0.3.0`.
- **Сохранение тега v0.2.53 (Инвариант целостности):**
  - Опубликованный тег `v0.2.53` (`7d0b5b8`) категорически **НЕ удаляется и НЕ переносится**; он остаётся валидной неизменной исторической точкой.
  - Доказано кодом Beyond Boundaries Core (`server/dist/start-server.js`):
    - Резолвер обновлений `resolveGitRangeUpdate` при отсутствии тега даёт отказ: `security check failed: recorded git tag "${args.intent.resolvedTag}" no longer exists in ${args.url}; bb will not re-resolve a missing release tag. Restore the tag, or remove and install the plugin again` (`outcome: "unavailable"`).
    - При смещении тега на новый коммит (`movedGitTagDetail`): `security check failed: git tag "${args.tag}" in ${args.url} moved from ${args.recordedCommit} to ${args.currentCommit}; bb will not re-resolve a tag that changed. Remove the plugin and install it again to accept the new commit` (`outcome: "unavailable"`).
  - Разделение границ: доказан отказ апдейт-резолвера (`outcome: "unavailable"` при фоновой проверке обновлений), а не автоматическая гибель уже запущенного resident runtime. Удаление GitHub Release и удаление git tag — раздельные сущности (архивы git tag обслуживаются Git archive endpoint независимо от GH Release), но мутация git-тега разрушает проверку целостности в BB Core.
- **Селекторная несовместимость (^0.2.0 vs 0.3.0):**
  - В semver `^0.2.0` раскрывается как `>=0.2.0 <0.3.0-0` (`semver.satisfies("0.3.0", "^0.2.0") === false`). Резолвер `satisfyingGitSemverTags` в BB Core вернёт `outcome: "current"` и не увидит 0.3.0 как допустимый апдейт.
  - По `assertInstallRegistrationAvailable` в BB Core параллельная установка поверх другого диапазона блокируется (`plugin id "..." is already installed from ...; remove it first`).
  - Для перехода установленного плагина на 0.3.0 потребуется отдельная процедура смены селектора (re-install / source change с пре-дренажем и согласованным перезапуском).
- **Статус ворот и релиза на момент поправки:**
  - G3 UI exception — **PENDING** (не получено).
  - G2 live roundtrip — **BLOCKED / unproven** (не подтверждено в живом Electron-рантайме).
  - Ворота НЕ отмечаются закрытыми.
  - Исторические факты и отчёты о релизе `0.2.53` сохраняются без изменений.

### Backend Release Slice 0.3.0 — 2026-10-26 (Execution Receipt)
- **Основание и полномочия оператора:** Ваня явно поручил выпустить текущий проверенный backend как 0.3.0 сейчас, а незавершённый арх-луп продолжать после выпуска. Все действия и добавления ведутся в рамках одного арх-лупа и фиксируются в общем плане/ledger. Новые запросы дополняют работу, а не отменяют предыдущий scope.
- **Scope релиза 0.3.0 (Проверенная функциональность):**
  - **Pi 1.4 Foundation:** точные пины 1.4.0 (`@earendil-works/pi-durable`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-codemode`, `@earendil-works/chord`, `@earendil-works/pi-ai`), SDK 0.6.79, Zod 4.6.6, Undici 8.12.2.
  - **Runtime Graph Backend (G1):** read-only модель `src/runtime-graph/`, `src/runner/runtime-graph-*.ts`, дебаунсированные снимки, фильтрация областей видимости (scope filtering) для root и дочерних бесед, квитанции завершения (receipts) с ограничением до 128 записей.
  - **Session Admission Coordinator & Single Writer:** мьютекс сессий `src/host/session-admission.ts`, защита от гонок создания сессий и конфликтов SQLite lock, точечная отмена ожидающих участников без обрыва активной работы.
  - **BB Identity Contract:** легитимный alias `providerThreadId` для дочерних субтредов, строгий запрет подмены составных идентификаторов (foreign composite root) и враждебной смены сессий на том же треде.
  - **Native Edit Single-File Patch:** канонический unified git diff, единая карточка файла на вызов edit.
  - **Subagent Model Policy v1:** централизованное управление политикой (`inherit` / `configured`) через KV.
- **Честные границы — открытый scope арх-лупа:**
  - **G2 (Public Live BB Event Transport): BLOCKED / unproven live roundtrip** (трансляция дельт и событий протестирована в unit/mock; живой сквозной roundtrip через Electron десктоп остаётся непроверенным live seam).
  - **G3 (UI Context Segment & Permission): PENDING** (разрешение оператора на UI-компоненты ещё не выдано; прототипы в `src/ui/runtime-graph/` ожидают согласования).
  - В релизе 0.3.0 UI графа и живой сквозной транспорт пользователям **НЕ обещаны и НЕ объявлены**.
- **Инвариант неприкосновенности тега v0.2.53:**
  - Тег `v0.2.53` (`7d0b5b8`) и GitHub Release `v0.2.53` **НЕ удалены и НЕ перемещены**, сохраняются неизменными.
- **Свежая верификация артефактов 0.3.0:**
  - `npx tsc --noEmit`: exit code 0, 0 ошибок.
  - `npm run test:contracts`: exit code 0 (`tsconfig.contract-tests.json` чисто, negative guard подтверждает TS2322).
  - `npm test`: **510 тестов, 26 сьютов: 510 pass, 0 fail** (501 node:test + 9 UI tsx).
  - Import AST SCC: `node scripts/verify-import-graph.mjs && node --test tests/import-graph.test.ts` — 123 файла, **0 циклов (Tarjan SCC)**.
  - AP-019 File Line Budgets: **0 нарушений** во всех `.ts`/`.tsx` файлах `src/` и `tests/` (включая обновлённый `tests/provider-installation.test.ts` — 189 строк).
  - Dependency Security: `npm audit` — **0 vulnerabilities**.
  - Dist build: `npm run build` — exit code 0 (`dist/runner/index.js`, `dist/server.js`, `dist/app.js`, `dist/host.js`, `dist/*.meta.json` актуализированы на версию 0.3.0).
  - Известные примечания: vendor trailing whitespace в bundled `dist/server.js` (от сторонних библиотек esbuild) и известный placement advisory SDK в `dependencies` (SawyerHood review blocker для изолированных воркеров).
- **Installed Status:** **NOT CHANGED** (установленный плагин остаётся на 0.2.53; смена селектора и локальное переключение — следующие шаги цикла).
- **Следующие срезы текущего арх-лупа:** Local cutover / installation migration, marketplace PR, G2 live roundtrip verification, G3 UI renderer.



