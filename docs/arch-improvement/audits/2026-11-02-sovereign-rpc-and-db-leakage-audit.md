# Архитектурный аудит: Суверенный RPC-протокол Durable Zero и устранение утечек базы данных

- **Дата:** 2026-11-02
- **Цикл:** Cycle 106
- **Объекты аудита:** `durable-zero` (`packages/contracts`, `packages/core`), `bb-plugin-provider-pi-durable` (`src/host/`)
- **Статус:** FAIL (Требуется рефакторинг архитектурных границ и протокола)

---

## 1. Контекст и проблема

В ходе аудита выявлены два фундаментальных архитектурных дефекта, нарушающих принцип суверенности ядра `durable-zero` (Ports & Adapters, Separation of Concerns):

1. **Утечка деталей реализации БД в хост BB (P1)**:
   Хост-плагин `bb-plugin-provider-pi-durable` напрямую импортирует `DatabaseSync` из `node:sqlite` и исполняет SQL-запросы в файлах `session.sqlite`. Вся логика создания форков сессий, проверки таблиц `sqlite_master` и очистки записей `entries`/`tasks` вынесена в хост, а не инкапсулирована внутри ядра.
2. **Протекание приватного IPC-механизма Beyond Boundaries в ядро (P1)**:
   В `durable-zero/packages/core/src/bridge-channel.ts` и `runner-server.ts` захардкожены приватные файловые дескрипторы `CHILD_TO_BRIDGE_FD = 3` и `BRIDGE_TO_CHILD_FD = 4`. Ядро `durable-zero` рассчитывает на специфичные пайпы Beyond Boundaries для динамических инструментов и UI-диалогов, делая невозможным запуск раннера как суверенного процесса через стандартный `stdio`.

---

## 2. Локализация дефектов

### Дефект D-106-01 (P1): Прямой доступ хоста к SQLite (DB Leakage)
- **Файлы:**
  - `bb-plugin-provider-pi-durable/src/host/thread-fork.ts:2, 24, 71–75`
  - `bb-plugin-provider-pi-durable/src/host/subthread-spawner.ts:5`
  - `bb-plugin-provider-pi-durable/src/host/runner-lookup.ts:2`
- **Проявление:**
  Хост Beyond Boundaries напрямую открывает базу сессии через `DatabaseSync`, проверяет существование таблиц `entries` и `tasks`, копирует файлы базы и выполняет `DELETE FROM entries WHERE ...`.
- **Нарушение канона:**
  AP-002 (Single Source of Truth), AP-010 (Hexagonal Architecture / Ports & Adapters). База данных — это закрытая деталь реализации `durable-zero`. Хост не имеет права знать внутреннюю схему SQLite.

### Дефект D-106-02 (P1): Протекание FD 3/4 Beyond Boundaries в `durable-zero`
- **Файлы:**
  - `durable-zero/packages/core/src/bridge-channel.ts:6–7`
  - `durable-zero/packages/core/src/runner-server.ts:12, 74, 160`
- **Проявление:**
  Ядро ожидает наличие дескрипторов 3 и 4 для `sendToBridge` и `initBridgeInboundChannel`. При запуске вне Beyond Boundaries дескрипторы 3 и 4 отсутствуют, блокируя обработку динамических инструментов хоста.
- **Нарушение канона:**
  AP-001 (Sovereign Core Purity), AP-012 (Coupling to External Harness). Ядро должно быть 100% агностично к Beyond Boundaries.

### Дефект D-106-03 (P2): Неполнота контракта команд RPC
- **Файлы:**
  - `durable-zero/packages/contracts/src/runner-command.ts`
- **Проявление:**
  В протоколе отсутствуют команды `session_fork`, `session_info`, `tool_call_response`, `interaction_response`. Из-за отсутствия этих команд хост был вынужден обращаться к базе или к FD 3/4.
- **Нарушение канона:**
  AP-003 (Protocol Completeness). Wire-протокол должен выражать полный функционал управления жизненным циклом и возможностями хоста.

---

## 3. Требуемое целевое состояние

1. **Единый Wire-протокол на `stdio` (или UDS)**:
   Все входящие запросы (команды пользователя, ответы на инструменты, команды форка) идут в один поток `stdin`. Все исходящие события (дельты текста, статус задач, запросы на выполнение инструментов хоста `tool_call_request`) идут в поток `stdout`.
2. **Нулевая зависимость хоста от SQLite**:
   В `bb-plugin-provider-pi-durable` удаляются все импорты `node:sqlite`. Операция `fork` делегируется команде `session_fork` в `durable-zero`.
3. **Ликвидация FD 3/4 в ядре**:
   Файл `bridge-channel.ts` удаляется из `durable-zero`. Двустороннее общение идет через канонические сообщения протокола.
