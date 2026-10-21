

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
