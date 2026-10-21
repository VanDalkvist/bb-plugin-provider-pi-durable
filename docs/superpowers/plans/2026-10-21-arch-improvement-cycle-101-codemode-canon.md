# Arch Improvement Cycle 101: Canonical Codemode Routines, Dynamic Namespaces & Prompt Guidelines

**Goal:** Реализовать канонические рутины использования `codemode` по стандарту Pi (`@earendil-works/pi-coding-agent` и `@earendil-works/pi-durable`): динамическое извлечение `namespaces` MCP серверов без хардкода, канонические prompt guidelines и сниппеты в `src/runner/prompt.ts`, обеспечивающие осознанный выбор `codemode` моделью для батчинга и цепочек вызовов, с сохранением AP-010, AP-018, AP-019 (< 200 строк), AP-028 (TDD) и AP-029 (Zero `any`).

## Architecture Context Map
- `src/runner/prompt.ts` — расширение `CANONICAL_TOOL_DEFS` каноническими сниппетами и guidelines для `codemode` и `tool_search`.
- `src/runner/harness-setup.ts` — динамический генератор `extractToolNamespaces()` и передача `namespaces` в `createCodemodeExtension`.
- `src/runner/runtime-loader.ts` — проброс конфигурации серверов из `loadMcpConfig` в `createCodingRegistry`.
- `tests/codemode-canonical-routines.test.ts` — новый TDD тест-сьют для верификации динамических неймспейсов, промпт-сниппетов и правил `<rules>`.

## Triage
- `fix-now`:
  - **F-101-1**: Добавление канонических сниппетов и promptGuidelines для `codemode` и `tool_search` в `CANONICAL_TOOL_DEFS` (`src/runner/prompt.ts`).
  - **F-101-2**: Динамическое извлечение и проброс `namespaces` MCP серверов в `createCodemodeExtension` (`src/runner/harness-setup.ts`, `src/runner/runtime-loader.ts`).
- `log-only`: нет.
- `blocked`: нет.

## Step-by-Step Implementation Slices

### Slice 1: Prompt Guidelines and Canonical Snippets (src/runner/prompt.ts)
- [ ] Добавить в `CANONICAL_TOOL_DEFS` записи для `codemode` и `tool_search` с каноническими текстами из `pi-coding-agent`.
- [ ] Убедиться, что в `<rules>` добавляется правило батчинга: `"Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls."`
- [ ] Проверить лимит строк (AP-019 < 200).

### Slice 2: Dynamic MCP Namespaces Extraction (src/runner/harness-setup.ts & runtime-loader.ts)
- [ ] В `src/runner/harness-setup.ts` добавить хелпер `extractToolNamespaces(configuredServers, toolNames)` для динамического формирования массива `CodemodeNamespace[]`.
- [ ] В `createCodingRegistry` принимать опциональный `namespaces?: CodemodeNamespace[]` и передавать в `createCodemodeExtension({ sandbox, namespaces })`.
- [ ] В `src/runner/runtime-loader.ts` извлекать серверы через `loadMcpConfig` и передавать полученные неймспейсы в `createCodingRegistry`.
- [ ] Проверить лимиты строк в `harness-setup.ts` и `runtime-loader.ts` (AP-019 < 200).

### Slice 3: TDD Test Suite & Verification
- [ ] Создать `tests/codemode-canonical-routines.test.ts`:
  - Проверка генерации `<tools>` со сниппетом codemode.
  - Проверка включения правила батчинга в `<rules>`.
  - Проверка динамического извлечения `namespaces` из списка серверов без хардкода.
  - Проверка группировки инструментов в секции `<codemode>`.
- [ ] Запустить полный набор тестов: `npm test`.
- [ ] Собрать раннер и хост: `npm run build`.
- [ ] Обновить версию плагина в `package.json` до `0.2.49`.

### Slice 4: Release, Verification & Dual-Circuit Review
- [ ] Архитектурный ревьюер (`arch-rules-implementation-review`).
- [ ] Продуктовый ревьюер (`arch-improvement-product-review`).
- [ ] Обновление `docs/arch-improvement/ledger.md`.
- [ ] Git commit, push, тег `v0.2.49` и обновление плагина в BB (`bb plugin update provider-pi-durable --yes`).
