# Arch Improvement Cycle 100: Canonical MCP Connection & Extension Lifecycle Hooks Parity

**Goal:** Реализовать каноническое подключение MCP-серверов и полную поддержку событий жизненного цикла расширений Pi (`agent_end`, `agent_settled`, `session_before_compact`) в `bb-plugin-provider-pi-durable`, устранив гонку инициализации `waitForDirectServers` и ложный варнинг `reachesTools`, с сохранением AP-010 (The Thin Adapter Invariant), AP-013, AP-019 (< 200 строк), AP-028 (TDD) и AP-029 (Zero `any`).

## Architecture Context Map
- `src/runner/diagnostics-types.ts` — реестр `SUPPORTED_EXTENSION_HOOKS`.
- `src/runner/extension-bridge.ts` — реализация `actions.getAllTools()` с возвратом host callable tools (`codemode`, `tool_search`) с флагом `reachesTools: true`.
- `src/runner/extension-mount.ts` — ожидание готовности макротаски `createMcpExtension` перед вызовом `emitBeforeAgentStart`.
- `src/runner/runtime-controller.ts` — отправка `agent_end` и `agent_settled` в `watchAnswer()`, отправка `session_before_compact` и `session_compact` в `compact()`.
- `tests/lifecycle-hooks-mcp.test.ts` — новый TDD тест-сьют для валидации эмита хуков и готовности MCP-инструментов.

## Triage
- `fix-now`:
  - **F-100-1**: Проброс `agent_end` и `agent_settled` в `runtime-controller.ts`.
  - **F-100-2**: Проброс `session_before_compact` в `runtime-controller.ts`.
  - **F-100-3**: Устранение гонки `waitForDirectServers` и поддержка `reachesTools: true` в `extension-bridge.ts` и `extension-mount.ts`.
  - **F-100-4**: Регистрация новых поддерживаемых хуков в `SUPPORTED_EXTENSION_HOOKS` в `diagnostics-types.ts`.

## Step-by-Step Implementation Slices

### Slice 1: Diagnostics and Types Update (AP-019 < 200 строк)
- [ ] Добавить `agent_end`, `agent_settled`, `session_before_compact`, `session_compact` в `SUPPORTED_EXTENSION_HOOKS` в `src/runner/diagnostics-types.ts`.
- [ ] Проверить лимиты строк (AP-019 < 200).

### Slice 2: ReachesTools & MCP Startup Race Fix in Extension Bridge & Mount
- [ ] В `src/runner/extension-bridge.ts` в `actions.getAllTools` включить `getCallableTools()` с флагом `reachesTools: true` для `codemode` и `tool_search`.
- [ ] В `src/runner/extension-mount.ts` перед первым `emitBeforeAgentStart` подождать завершения макротаски (`await new Promise((r) => setImmediate(r))`), чтобы `startConnection` успел проинициализировать промисы `server.ready`.
- [ ] Проверить лимиты строк в `extension-bridge.ts` и `extension-mount.ts` (AP-019 < 200).

### Slice 3: Lifecycle Hooks Forwarding in Runtime Controller
- [ ] В `src/runner/runtime-controller.ts` в `watchAnswer`:
  - При переходе submission в завершённое состояние вызывать `await ctx.extensionRunner?.emit({ type: "agent_end", messages: [] })`.
  - Вызывать `await ctx.extensionRunner?.emit({ type: "agent_settled" })`.
- [ ] В `src/runner/runtime-controller.ts` в `compact`:
  - Перед запуском `harness.compact` вызывать `await ctx.extensionRunner?.emit({ type: "session_before_compact", ... })`.
  - При успехе компакта вызывать `await ctx.extensionRunner?.emit({ type: "session_compact", ... })`.
- [ ] Проверить лимит строк в `runtime-controller.ts` (AP-019 < 200).

### Slice 4: TDD Test Suite & Verification
- [ ] Написать `tests/lifecycle-hooks-mcp.test.ts` (тестирование регистрации `codemode` с `reachesTools`, проверка вызова хуков `agent_end`, `agent_settled`, `session_before_compact`).
- [ ] Запустить полный тест-сьют: `npm test`.
- [ ] Собрать раннер и хост: `npm run build`.
- [ ] Запустить `npm run doctor` для проверки отсутствия неподдерживаемых хуков в gbrain.
- [ ] Синхронизировать сборку в кеш плагинов BB (`~/.bb/plugins/cache/git/github.com/VanDalkvist/bb-plugin-provider-pi-durable/*/dist/`) и перезагрузить плагин: `bb plugin reload provider-pi-durable`.

### Slice 5: Verification & Dual-Circuit Review
- [ ] Архитектурный ревьюер (`arch-rules-implementation-review`).
- [ ] Продуктовый ревьюер (`arch-improvement-product-review`).
- [ ] Обновление `docs/arch-improvement/ledger.md`.
- [ ] Git commit & push в `main`.
