# Исследование: Архитектурные паттерны безопасной миграции SDK без регрессий (Design of Arch Improvement Loop for Upstream SDK Migration)

**Дата:** 2 ноября 2026 г.  
**Контекст:** Миграция ядра `bb-plugin-provider-pi-durable` и `durable-zero` с `@earendil-works/*@1.4.0` на `@earendil-works/*@1.5.0` (Breaking: удаление `watchEvents()`, замена TypeBox на `pi-schema`, внедрение Group Commit).  
**Цель:** Спроектировать архитектурный цикл (Arch Improvement Loop), гарантирующий **нулевой регресс** в уже работающем функционале (755 тестов, стабильный UI десктопа Beyond Boundaries, суверенный CLI).

---

## 1. Фундаментальные инженерные паттерны миграции (Industry State-of-the-Art)

На основе анализа современной практики эволюционного проектирования (Martin Fowler, Michael Feathers, Alistair Cockburn, MinimumCD) выделены 4 ключевых паттерна для безопасного обновления сторонних SDK с ломающими изменениями:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   1. Anti-Corruption Layer (ACL)                       │
│    Внешний SDK 1.5 никогда не проникает напрямую в доменную модель     │
│                                                                        │
│                   2. Branch by Abstraction                             │
│     Переключение реализации через порт без веток в системе контроля    │
│                                                                        │
│                   3. Expand and Contract (Parallel Change)             │
│        Новый и старый драйвер сосуществуют до полной верификации       │
│                                                                        │
│                   4. Characterization Testing (Golden Master)          │
│       755 существующих тестов выступают абсолютным инвариантом         │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.1. Anti-Corruption Layer (ACL, Эрик Эванс)
- **Проблема:** При прямом импорте структур SDK (`pi-schema`, `ConversationView`, `WatchCall`) любое изменение сигнатур upstream ломает весь проект (15+ файлов).
- **Решение:** Создание изолирующего слоя адаптеров на границе ядра:
  - `SchemaPort`: изолирует валидацию аргументов инструментов. Доменные инструменты объявляют свои параметры через стабильный интерфейс, а ACL транслирует их либо в TypeBox (1.4), либо в `pi-schema` (1.5).
  - `ViewStreamProjector`: изолирует удаление `watchEvents()`. Он принимает поток состояний `ConversationView` и синтезирует канонические события `RunnerEvent` (`agent_start`, `turn_start`, `tool_execution_*`), которые ожидает хост Beyond Boundaries.

### 1.2. Branch by Abstraction (Мартин Фаулер)
- **Проблема:** "Big-Bang" обновление (одновременная замена всех зависимостей в `package.json`) приводит к каскаду из 50+ ошибок компиляции, блокируя запуск тестов на несколько дней.
- **Решение:**
  1. Выделяется порт `DurableEnginePort`.
  2. Существующий код оборачивается как `DurableEngineV14Adapter`.
  3. Рядом пишется `DurableEngineV15Adapter` с поддержкой Group Commit и `pi-schema`.
  4. Переключение выполняется одной строкой в Composition Root (`container.register('Engine', V15Adapter)`).
  5. Старый адаптер удаляется только после 100% прохождения сьюта.

### 1.3. Shadow Execution & Delta Verification (Теневой прогон)
- В тестах запускаются параллельно две проекции:
  `LegacyProjection (watchEvents)` vs `NewProjection (ConversationView)`
- Сравнивается поток генерируемых `RunnerEvent`: типы событий, последовательность `id`, наличие `conversationId`, `details` и тайминги.
- Когда дифференциал равен 0, от старой проекции можно безопасно отказаться.

---

## 2. Архитектура Цикла Миграции (Migration Arch Loop Framework)

Стандартный Arch Improvement Loop (S0–S12) адаптируется под специфику **Upstream SDK Migration**:

```
 S0: Pinned Baseline (755 tests green, git clean)
   │
 S1: Port Definition (Выделение портов SchemaPort & StreamPort)
   │
 S2: Shadow Component Development (TDD реализация V1.5 адаптеров)
   │
 S3: Differential Verification (Golden Master тесты: V1.4 vs V1.5)
   │
 S4: Dependency Flip (Обновление package.json до 1.5.0)
   │
 S5: Pruning & Contraction (Удаление старых адаптеров 1.4)
   │
 S6: Two-Circuit Verify Gate (Arch + Product Review)
```

---

## 3. Детальный план безопасных срезов (Zero-Breakage Slices)

### Срез 1: Слой абстракции схем (`SchemaPort` & `SchemaAdapter`)
- **Задача:** Отвязать `tool-adapter.ts` и `extension-mount.ts` от прямой зависимости от TypeBox.
- **Архитектура:**
  ```ts
  export interface ToolSchemaValidator {
      validate(schema: unknown, value: unknown): { isValid: boolean; errors?: string[] };
      coerce(schema: unknown, value: unknown): unknown;
  }
  ```
- **Почему не сломает старое:**
  - На шаге 1 валидатор делегирует в существующий TypeBox `Value.Check()`.
  - На шаге 2 добавляется поддержка `@earendil-works/pi-schema` с 3-проходной коэрцией.
  - Существующие инструменты (`bash`, `read`, `write`, `edit`, MCP) продолжают работать без изменения их определений.

### Срез 2: Проектор событий `ViewStreamProjector` (Замена `watchEvents`)
- **Задача:** Построить синтезатор событий `RunnerEvent` из `conversation.watch()` без изменения контрактов `DurableEventAdapter`.
- **Архитектура:**
  - `ViewStreamProjector` подписывается на `WatchCall<ConversationView>`.
  - При появлении `view.live.run` генерирует `agent_start`.
  - При обновлении `view.live.generation.message` генерирует текстовые дельты `call.ops`.
  - При обновлении `view.live.tools` генерирует `tool_execution_start/update/end`.
- **Контроль регрессий:**
  - Тест `tests/view-stream-parity.test.ts`: прогон записи реального сеанса через старый `watchEvents` и новый `ViewStreamProjector`. Проверка 100% идентичности дельт для Beyond Boundaries.

### Срез 3: Адаптер вотчеров Chord v2 (`WatchHandleCompat`)
- **Задача:** Поддержать новый формат `WatchCall ({ kind: 'value', value, ops })` в `subagent-courier.ts`.
- **Архитектура:**
  - Защитный хелпер `unwrapWatchValue(call: unknown): T`:
    Если передан объект с `kind === 'value'`, возвращает `call.value`; если передан старый скаляр (1.4), возвращает его напрямую.
- **Результат:** FSM курьера субагентов работает одинаково надежно на обеих версиях рантайма.

### Срез 4: Переключение зависимостей и Group Commit
- **Задача:** Обновление `package.json` до `@earendil-works/*@1.5.0`.
- **Защита от рисков Group Commit:**
  - Защита от `Object.freeze`: проверка в `session-storage.ts` и `runtime.ts` — все обращения к объектам базы данных оборачиваются в поверхностное клонирование (`structuredClone` или `{ ...obj }`) перед мутацией.
  - Тестирование конкурентных коммитов: прогон `tests/session-group-commit.test.ts`.

### Срез 5: Сжатие и очистка (Contract Phase)
- Удаление устаревших хелперов 1.4.
- Финализация релиза v0.6.0.

---

## 4. Стратегия отката (Fail-Safe Rollback Invariant)

1. **Изоляция в git:** Вся миграция оформляется как атомарный PR/ветка или строгий цикл со срезами, где каждый срез оставляет сьют тестов 100% зелёным.
2. **Нулевая миграция БД:** Так как схема `session.sqlite` осталась в версии 2, откат на версию 1.4.0 не требует даунгрейда базы данных и не приводит к потере сессий пользователей.
3. **Хранение Golden Master фикстур:** Сохранение снапшотов реальных сессий в `tests/fixtures/v1.4-session.sqlite` для гарантии обратной совместимости чтения старых тредов.
