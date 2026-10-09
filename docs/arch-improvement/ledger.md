

---

## Cycle 78: Pi Durable Doctor, Environment Diagnostics & Extension Compatibility Matrix

**Goal:** Создать честную систему диагностики окружения Pi и совместимости расширений (`inspectPiEnvironment`), CLI инструмент `npm run doctor`, дашборд `app.tsx` в BB IDE вместо устаревшего шаблона todos, RPC контракт `diagnostics_get`, и устранить дефекты передачи контекста в `ExtensionRunner`.

### 1. Triaged Findings & Dispositions

| ID | Issue / Defect | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-78-1** | Отсутствие контракта детальной диагностики Pi окружения и расширений | **P1** | AP-013, AP-028 | `fix-now` | Созданы `src/runner/diagnostics-types.ts` и `src/runner/diagnostics.ts` (170 строк, AP-019), собирающие аудит путей, настроек, моделей, расширений с разделением хуков на `supported` vs `unsupported`, инструментов и скиллов с единым статусом `healthy/warning/error`. |
| **F-78-2** | Заброшенный шаблон Todos в `app.tsx` и отсутствие RPC в `server.ts` | **P1** | AP-010, AP-019 | `fix-now` | Создан `src/rpc/contract.ts` с методом `diagnostics_get`, зарегистрирован в `server.ts`, а `app.tsx` переписан в полноценный UI-дашборд «Pi Durable Doctor» с отображением статуса среды, моделей, файлов и матрицы совместимости хуков. |
| **F-78-3** | Дефект передачи настроек и промпта в `ExtensionRunner` | **P2** | AP-010, AP-029 | `fix-now` | В `setupExtensionRunner` методы `getSettings()` и `getActiveTools()` наполнены реальными данными из `settingsManager` и `registry`. В `runtime-controller.ts` в `emitBeforeAgentStart` передается валидный объект с `cwd` и `sections`. |
| **F-78-4** | Отсутствие CLI-инструмента диагностики | **P2** | AP-028 | `fix-now` | Добавлен `scripts/doctor.mjs` и npm-команда `npm run doctor`, моментально выдающая форматированный аудит в терминале. |

### 2. Architecture Implementations
- **`src/runner/diagnostics-types.ts` & `src/runner/diagnostics.ts` (AP-019 < 200, AP-029 0 `any`):**
  - Определение контрактов `PiDiagnosticsReport`, `ExtensionDiagnostic`, `PiPathStatus`.
  - Набор поддерживаемых хуков `SUPPORTED_EXTENSION_HOOKS`: `session_start`, `session_shutdown`, `before_agent_start`, `tool_call`, `tool_result`.
  - Автоматическая классификация неподдерживаемых хуков (`agent_settled`, `agent_before_settle`, `turn_start`, `agent_start`, etc.) с предупреждениями в отчете.
- **`src/host/discovery-handler.ts` & `src/host/catalog.ts`:**
  - Добавлен метод `provider/diagnostics` в discovery handler.
  - `getHealth()` в `ModelCatalog` теперь валидирует полный отчет инспекции.
- **`server.ts` & `src/rpc/contract.ts`:**
  - Определение и регистрация контракта `diagnostics_get` для фронтенда плагина.
- **`app.tsx`:**
  - Полноценный React Dashboard с карточками Environment & Config files, Models & Settings, Extensions & Lifecycle Compatibility Matrix, Resolved Tools & Skills.
- **`tests/diagnostics.test.ts`:**
  - Детерминированные тесты отчета инспекции и классификации хуков расширений.

### 3. Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **145 / 145 passing assertions across 12 test suites (0 failures, 0 skips)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `npm run doctor`: Успешный запуск, вывел чистый структурированный аудит окружения.
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.
