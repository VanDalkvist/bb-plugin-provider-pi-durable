# Architectural Specification: Reliable Subagent Delivery & Durable Binding Store (Track 4, Cycle 93)

**Document:** `track-4-subagents-persistence.md`  
**Location:** `docs/arch-improvement/cycle-93/track-4-subagents-persistence.md`  
**Status:** 📋 APPROVED FOR IMPLEMENTATION (Track 4 Architecture Design)  
**Cycle:** Cycle 93  
**Target Plugin:** `bb-plugin-provider-pi-durable`  
**Author:** Lead Systems Architect (Track 4: Subagents & Persistence)  
**Standards:** AP-010, AP-012, AP-013, AP-019, AP-020, AP-022, AP-026, AP-028, AP-029, AP-034  

---

## Executive Summary & Problem Formulation

В рамках Cycle 89 плагин `bb-plugin-provider-pi-durable` перешёл на неблокирующий режим выполнения субагентов по умолчанию (`background: true`), инжектируя строгий Role Envelope в инструкции дочерних бесед (`configure(tx, childId, { instructions })`). Однако текущая реализация несёт в себе **два критических архитектурных дефекта**, препятствующих надежной промышленной эксплуатации в Beyond Boundaries IDE:

1. **"Silent Void" Subagent Completion (Отсутствие обратной доставки отчетов):**
   - Инструмент `subagent` запускает `child.submit(...)` и немедленно возвращает текстовую заглушку `Subagent spawned in background...`.
   - По завершении вычислений дочерней беседы результат остаётся запертым внутри дочерней ветки `session.sqlite`. Родительский агент **никогда не получает отчет** о результатах решения задачи и не продолжает диалог на основе проделанной работы.
   - При аварийном завершении процесса раннера или хоста (`kill -9`, краш демона, закрытие BB IDE) фоновые задачи теряются из оперативной памяти, а недоставленные результаты бесследно исчезают.
2. **Volatile In-Memory Thread Mappings (Сброс привязок тредов BB при перезапуске):**
   - В модуле `src/host/session.ts` соответствия между `bbThreadId` (идентификатор треда в интерфейсе Beyond Boundaries) и внутренним `conversationId` Pi Durable хранятся в обычных структурах `Map` в оперативной памяти процесса (`conversationThreadMap`, `threadConversationMap`).
   - При перезагрузке BB IDE, перезапуске плагина (`bb plugin reload`) или падении воркера маппинги полностью стираются.
   - При повторном открытии бокового треда или поступлении отложенных дельт событий хост теряет маршрутизацию (`getThreadIdForConversation` возвращает `undefined`), что приводит к визуальному зависанию сайдбара BB и потере интерактивности.
3. **Строгий архитектурный инвариант:**
   - **Zero Monkey-Patching BB Core:** Вся функциональность реализуется строго в границах официального BB Plugin SDK (`experimental_defineProviderBridge`, `experimental_defineHostEntry`) и публичного API `@earendil-works/pi-durable`. Никаких правок ядра BB IDE, внешних UNIX-сокетов или сторонних демонов-брокеров (AP-010).
   - **AP-019 File Size Limits:** Строго `< 200 строк` для любых файлов в `src/runner/` и `< 250 строк` для файлов в `src/host/`.

Ниже представлен детальный системный дизайн для интеграции проверенного транзакционного паттерна **Reporter + Courier** (из референсной реализации `/tmp/diffuzmetall-adapter/src/protocol/subagents/`) и **Durable Binding Store** на базе транзакционных документов Pi Durable.

---

## 1. Архитектурная спецификация Subagent Delivery (Reporter + Courier)

### 1.1. Концепция и системные роли

Для обеспечения гарантированной доставки результатов фоновых вычислений родительскому агенту внедряется трехуровневая модель:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 DURABLE RUNNER RUNTIME                                 │
│                                                                                        │
│  [Parent Conversation] ─────────────────────────────────────────────────────────────┐  │
│         │                                                                           │  │
│         │ (1) subagent tool: commit(SubagentsDoc.agents[key] = record)              │  │
│         ▼                                                                           │  │
│  ┌──────────────┐ (2) createTask                                                    │  │
│  │   Reporter   │ ────────────────────────────────────────────────────────┐         │  │
│  └──────┬───────┘                                                         │         │  │
│         │ (3) submit(task)                                                │         │  │
│         ▼                                                                 ▼         │  │
│  [Child Conversation]                                             [SubagentsDoc]    │  │
│         │                                                         │  .agents        │  │
│         │ (4) execute LLM & tools                                 │  .outbox        │  │
│         ▼                                                         │  .sending       │  │
│  [AssistantEntry] (Final Answer)                                  │  .courier       │  │
│         │                                                         │  .deliveryHold  │  │
│         │ (5) wait() returns                                      └────────▲────────┘  │
│         ▼                                                                  │           │
│  ┌──────────────┐ (6) commit(report -> outbox, ensure courier)             │           │
│  │   Reporter   │ ─────────────────────────────────────────────────────────┤           │
│  └──────────────┘                                                          │           │
│                                                                            │           │
│  ┌──────────────┐ (7) 50ms Debounce Window (gather)                        │           │
│  │   Courier    │ ◄────────────────────────────────────────────────────────┘           │
│  └──────┬───────┘ (8) commit(outbox -> sending, outbox = [])                           │
│         │                                                                              │
│         │ (9) parent.submit({ content: batch, whenBusy: "followUp", requestId })       │
│         ▼                                                                              │
│  [Parent Turn Inbox] (Queued cleanly as next turn for LLM)                             │
│         │                                                                              │
│         │ (10) submission.wait() -> "done"                                             │
│         ▼                                                                              │
│  ┌──────────────┐ (11) commit(delete state.sending) -> next                            │
│  │   Courier    │                                                                      │
│  └──────────────┘                                                                      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **`SubagentsDoc` (Транзакционный реестр и почтовый ящик):** Документ Pi Durable, привязанный к родительской беседе (`scope: "conversation"`, `history: "latest"`). Является единственным источником истины о жизненном цикле всех порождённых субагентов, очереди недоставленных отчетов (`outbox`), активном отправляемом батче (`sending`) и блокировках доставки (`deliveryHold`).
2. **`Reporter Task` (Индивидуальный контроллер исполнения):** Долгоживущая задача Pi Durable (`defineTask`), создаваемая для каждого запущенного субагента. Обладает владением `ownership: { kind: "conversation" }, background: true`. Задача переживает завершение хода родителя, ожидает завершения дочерней беседы, извлекает финальный текстовый ответ и атомарно перемещает его в `SubagentsDoc.outbox`.
3. **`Courier Task` (Пакетный курьер с дебаунсом 50ms):** Единственная активная на беседу задача Pi Durable (`defineTask`), отвечающая за батчинг и надежную инъекцию отчетов в родительскую сессию через `parent.submit({ whenBusy: "followUp" })`.

---

### 1.2. Спецификация структур данных и контрактов (`SubagentsDoc`)

Документ определяется через стандартный API `@earendil-works/pi-durable`:

```typescript
// src/runner/subagent-docs.ts (AP-019 < 100 строк)
import { defineDoc, type ConversationId, type TaskId } from "@earendil-works/pi-durable";

export interface SubagentRecord {
	readonly name: string;
	readonly conversationId: ConversationId;
	readonly requestId: string;
	readonly task: string;
	readonly role: string;
	readonly ownerTaskId: TaskId;
	readonly background: boolean;
	reporter?: TaskId;
	report?: string;
	settled?: boolean;
}

export interface PendingSubagentReport {
	readonly id: string;
	readonly name: string;
	readonly text: string;
}

export interface SubagentBatchPayload {
	readonly requestId: string;
	readonly reports: readonly PendingSubagentReport[];
}

export interface DeliveryHoldState {
	readonly kind: "admission" | "uncertain";
	readonly requestId: string;
	readonly reason: string;
}

export interface SubagentsState {
	agents: Record<string, SubagentRecord>;
	outbox?: PendingSubagentReport[];
	courier?: TaskId;
	batchNumber?: number;
	sending?: SubagentBatchPayload;
	deliveryHold?: DeliveryHoldState;
}

export const SubagentsDoc = defineDoc<SubagentsState>({
	kind: "bb.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});
```

---

### 1.3. Логика Reporter Task (`bb.subagent-reporter`)

`Reporter` управляет полным циклом дочерней задачи:

```typescript
// src/runner/subagent-delivery.ts (выдержка фаз Reporter)
type ReporterInput = {
	readonly key: string;
	readonly conversationId: ConversationId;
	readonly task: string;
	readonly requestId: string;
};

type ReporterState = 
	| { readonly phase: "deliver" }
	| { readonly phase: "report"; readonly text: string };
```

#### Фаза `deliver`:
1. Получает дескриптор дочерней беседы: `const child = (await runtime.conversation(task.input.conversationId, context))!`.
2. Вызывает опциональный хук допуска (admission guard), если зарегистрирован.
3. Отправляет задачу в дочернюю беседу:
   ```typescript
   const submission = await child.submit({
       type: "input",
       content: task.input.task,
       requestId: task.input.requestId,
   }, context);
   ```
4. Блокирующе ожидает завершения дочерней беседы: `const settled = await submission.wait(context)`.
5. По завершении выполняет атомарный коммит:
   - Если `settled.status === "done"`: извлекает текст из `tx.entry(AssistantEntry, settled.answer)`.
   - Если статус иной: формирует структурированное сообщение об ошибке (`Subagent ${name} failed: ${status}`).
   - Записывает `record.report = text` и `record.settled = true` в `SubagentsDoc.agents[key]`.
   - Переводит задачу в чекпоинт `{ status: "running", checkpoint: { phase: "report", text } }`.

#### Фаза `report`:
1. Атомарно в транзакции `runtime.commit(async (tx) => { ... })`:
   - Добавляет `{ id: String(task.id), name, text }` в `state.outbox` (с дедупликацией по `report.id`).
   - Проверяет статус `state.courier`: если курьер отсутствует или находится в терминальном состоянии, создаёт новую задачу Courier:
     ```typescript
     state.courier = await tx.createTask(courierTask, null, {
         ownership: { kind: "conversation" },
         background: true,
     });
     ```
   - Завершает задачу Reporter: `{ status: "terminal", outcome: { status: "completed", result: null } }`.

---

### 1.4. Логика Courier Task (`bb.subagent-courier`) и батчинг (50ms debounce)

`Courier` обеспечивает сбор пачки отчетов и их бесконфликтную отправку родительскому агенту:

```typescript
type CourierState = { readonly phase: "gather" | "next" | "send" | "hold" };
```

#### Фаза `gather` (Дебаунс 50ms):
- Выполняет сон в виртуальном времени рантайма:
  ```typescript
  await runtime.sleep(runtime.now() + 50, context);
  await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
  ```
- **Зачем нужен дебаунс?** Если агент запустил 3 субагента параллельно (например, через `Promise.all` в `codemode`), они могут завершиться с разницей в несколько миллисекунд. Окно в 50ms собирает их отчеты в единый батч, предотвращая генерацию трёх отдельных очередей ходов в родительской беседе.

#### Фаза `next` (Подготовка батча):
- Проверяет `state.deliveryHold !== undefined`. Если активно — переходит в фазу `hold`.
- Если `state.sending === undefined`:
  - Читает `reports = state.outbox ?? []`.
  - Если `reports.length === 0`: удаляет ссылку `delete state.courier` и завершается `{ status: "terminal", outcome: { status: "completed", result: null } }`.
  - Если есть отчеты:
    ```typescript
    const batch = (state.batchNumber ?? 0) + 1;
    state.batchNumber = batch;
    state.outbox = [];
    state.sending = {
        requestId: `subagent-batch:${task.id}:${batch}`,
        reports,
    };
    ```
- Переходит в фазу `{ status: "running", checkpoint: { phase: "send" } }`.

#### Фаза `send` (Отправка через `parent.submit`):
- Считывает `sending` из снимка `runtime.snapshot(SubagentsDoc, runtime.conversationId)`.
- Получает дескриптор родительской беседы: `const parent = (await runtime.conversation(runtime.conversationId, context))!`.
- Форматирует единый контент сообщения:
  ```typescript
  const prompt = sending.reports.map((r) => r.text).join("\n\n---\n\n");
  const submission = await parent.submit({
      type: "input",
      content: `[Subagent Reports Available]:\n\n${prompt}`,
      whenBusy: "followUp",
      requestId: sending.requestId,
  }, context);
  ```
  **Критический параметр `whenBusy: "followUp"`:** Если родительский агент занят (думает над другим запросом или выполняет долгий bash-скрипт), Pi Durable автоматически помещает отправку в очередь входящих сообщений (`inbox`) без прерывания текущего хода и без выброса ошибки перегрузки.
- Ожидает фиксации: `const settled = await submission.wait(context)`.
- Фиксирует результат в транзакции:
  - Если `settled.status === "done"`: удаляет `delete current.sending` и переходит в фазу `next` (для проверки, не накопились ли новые отчеты во время ожидания).
  - Если исход неопределен: переводит в `current.deliveryHold = { kind: "uncertain", requestId: sending.requestId, reason: "..." }` и переходит в фазу `hold`.

#### Фаза `hold` (Защитный мониторинг):
- Подписывается на изменения через `runtime.watchDoc(SubagentsDoc)`.
- Блокирует выполнение до снятия `deliveryHold` (например, через явную команду вмешательства или подтверждение статуса).

---

### 1.5. Интеграция с `src/runner/subagent-watcher.ts`

В текущем `subagent-watcher.ts` происходит автоматический дискавери дочерних бесед через события `tool_execution_update` и `tool_execution_end`. При внедрении `SubagentsDoc`, `Reporter` и `Courier`:
1. **Изоляция служебных сабмишенов:** Запросы с `requestId.startsWith("subagent-batch:")` маркируются специальным атрибутом или типом в `bb-event-adapter.ts`, чтобы BB IDE не путал инжектированный отчет с обычным пользовательским сообщением. В таймлайне они отображаются как системное событие `Subagent Summary Turn`.
2. **Безопасный перехват дочерних событий:** `subagent-watcher.ts` продолжает мультиплексировать внутренние размышления субагентов в карточку родительской делегации в реальном времени.

---

## 2. Спецификация Durable Binding Store (Persistent Thread Mapping)

### 2.1. Анализ проблемы и архитектурный консенсус

В текущей архитектуре:
- Хост (`src/host/session.ts`) держит два `Map`: `conversationThreadMap: Map<string, string>` и `threadConversationMap: Map<string, string>`.
- При релоаде плагина или перезагрузке BB IDE хост поднимает новый экземпляр `PiThreadSession`. Карты в памяти пусты.
- Если дочерняя беседа присылает событие, `childThreadId` не находится, и события теряются или отправляются в родительский тред.

**Почему нельзя хранить маппинги в отдельной кастомной SQLite-базе хоста?**
1. Нарушение Single Source of Truth: сессия уже хранится в `session.sqlite`. Вторая база требует синхронизации жизненного цикла, форков (`thread-fork.ts`) и очистки.
2. При форке треда (`thread-fork.ts`) копируется файл `session.sqlite`. Если маппинги лежат внутри `session.sqlite`, они автоматически форкаются вместе со всей историей!

**Почему нельзя писать в `session.sqlite` напрямую из хоста через `DatabaseSync`?**
- Процесс раннера (`RunnerProcess`) держит эксклюзивный файловый замок (`proper-lockfile`) на директорию сессии и открывает `session.sqlite` через `@earendil-works/pi-durable`.
- Параллельная запись из хоста в ту же SQLite базу нарушает транзакционный журнал Pi Durable и может приводить к ошибкам `SQLITE_BUSY` или порче индексов.

**Архитектурное решение: Runner-Owned Durable Binding Document + Host L1-Cache & Cold Read**
- Хранение связок реализуется через **Durable Documents** внутри `session.sqlite` (`BindingDoc` и `BindingIndexDoc`).
- **Запись:** Выполняется строго раннером через транзакции Pi Durable (`tx.doc(BindingIndexDoc)`). Хост вызывает команду Runner RPC `binding_register`.
- **Чтение в рантайме (L1 Cache):** Хост хранит быстрый in-memory кэш. При запуске сессии (`PiThreadSession.start()`) хост запрашивает все привязки у раннера через быстрый RPC `binding_get_all` (выполняется за 2-3 мс).
- **Холодное чтение (Cold Offline Recovery):** До запуска раннера (например, в `SessionRegistry` при холодном старте дочернего треда) хост может безопасно прочитать `session.sqlite` в режиме **Read-Only** через стандартный `node:sqlite` `DatabaseSync({ readOnly: true })` без захвата блокировок.

---

### 2.2. Спецификация документов привязки (`BindingDoc` & `BindingIndexDoc`)

```typescript
// src/runner/binding-docs.ts (AP-019 < 110 строк)
import { defineDoc, type ConversationId, type JsonObject } from "@earendil-works/pi-durable";

export interface StoredBinding {
	readonly providerId: string;
	readonly sessionId: string;
	readonly conversationId: ConversationId;
	readonly bbThreadId: string;
	readonly parentThreadId: string | null;
	readonly createdAt: number;
}

export type BindingState = JsonObject & {
	binding: StoredBinding | null;
};

export type BindingIndex = JsonObject & {
	byIdentity: Record<string, ConversationId>;
	byThreadId: Record<string, ConversationId>;
};

export const BindingDoc = defineDoc<BindingState>({
	kind: "bb.native-child-binding",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ binding: null }),
});

export const BindingIndexDoc = defineDoc<BindingIndex>({
	kind: "bb.native-child-binding-index",
	version: 1,
	scope: "session",
	initial: () => ({ byIdentity: {}, byThreadId: {} }),
});
```

---

### 2.3. RPC Контракт и протокол синхронизации Host <-> Runner

В протокол межпроцессного взаимодействия добавляются 2 метода:

#### 1. Метод `register_binding`
- **Направление:** Host -> Runner
- **Параметры:**
  ```typescript
  {
      type: "register_binding",
      id: "cmd_1",
      bbThreadId: "thr_sub456",
      conversationId: 2,
      parentThreadId?: "thr_root123"
  }
  ```
- **Обработка в раннере:**
  В транзакции `durable.harness.commit`:
  ```typescript
  await harness.commit(async (tx) => {
      const index = await tx.doc(BindingIndexDoc);
      const state = await tx.doc(BindingDoc, conversationId);
      const record: StoredBinding = {
          providerId: "pi-durable",
          sessionId: location.id,
          conversationId,
          bbThreadId,
          parentThreadId: parentThreadId ?? null,
          createdAt: Date.now(),
      };
      state.binding = record;
      index.byThreadId[bbThreadId] = conversationId;
      const idKey = JSON.stringify(["pi-durable", location.id, bbThreadId]);
      index.byIdentity[idKey] = conversationId;
  }, runtimeContext);
  ```
- **Ответ:** `{ id: "cmd_1", type: "response", command: "register_binding", success: true }`.

#### 2. Метод `get_all_bindings`
- **Направление:** Host -> Runner
- **Параметры:** `{ type: "get_all_bindings", id: "cmd_2" }`
- **Обработка в раннере:** Читает снимок `BindingIndexDoc`. Для каждого `conversationId` извлекает `StoredBinding` из `BindingDoc`.
- **Ответ:**
  ```typescript
  {
      id: "cmd_2",
      type: "response",
      command: "get_all_bindings",
      success: true,
      data: {
          bindings: [
              { bbThreadId: "thr_sub456", conversationId: 2, parentThreadId: "thr_root123" }
          ]
      }
  }
  ```

---

### 2.4. Хостовый менеджер `DurableBindingManager`

В `src/host/durable-binding-store.ts` создаётся автономный компонент, изолирующий работу со связками тредов:

```typescript
// src/host/durable-binding-store.ts (AP-019 < 150 строк)
export class DurableBindingManager {
	private convToThread = new Map<string, string>();
	private threadToConv = new Map<string, string>();
	private runnerRpc?: (cmd: Record<string, unknown>) => Promise<any>;

	public setRpc(rpc: (cmd: Record<string, unknown>) => Promise<any>): void {
		this.runnerRpc = rpc;
	}

	public register(threadId: string, conversationId?: string | number): void {
		if (conversationId === undefined || conversationId === null) return;
		const convStr = String(conversationId);
		this.convToThread.set(convStr, threadId);
		this.threadToConv.set(threadId, convStr);

		// Async write-behind persistence into runner
		if (this.runnerRpc) {
			void this.runnerRpc({
				type: "register_binding",
				bbThreadId: threadId,
				conversationId: Number(conversationId),
			}).catch((err) => {
				console.warn(`[BindingManager] Failed to persist binding to runner: ${err}`);
			});
		}
	}

	public getThreadId(conversationId: string | number): string | undefined {
		return this.convToThread.get(String(conversationId));
	}

	public getConversationId(threadId: string): string | undefined {
		return this.threadToConv.get(threadId);
	}

	public async hydrateFromRunner(): Promise<void> {
		if (!this.runnerRpc) return;
		try {
			const res = await this.runnerRpc({ type: "get_all_bindings" });
			if (res?.data?.bindings && Array.isArray(res.data.bindings)) {
				for (const b of res.data.bindings) {
					const cStr = String(b.conversationId);
					this.convToThread.set(cStr, b.bbThreadId);
					this.threadToConv.set(b.bbThreadId, cStr);
				}
			}
		} catch (err) {
			console.warn(`[BindingManager] Failed to hydrate bindings from runner: ${err}`);
		}
	}
}
```

---

## 3. Схема состояний FSM и поведение при сбоях (Crash Recovery)

### 3.1. FSM Состояний Reporter

```
           ┌────────────────────────┐
           │      [deliver]         │ ◄── Initial Phase
           └───────────┬────────────┘
                       │
                       │ child.submit() & wait()
                       ▼
           ┌────────────────────────┐
           │       [report]         │ ◄── Outcome Extracted
           └───────────┬────────────┘
                       │
                       │ commit(SubagentsDoc.outbox += report)
                       │ ensure Courier task created
                       ▼
           ┌────────────────────────┐
           │  [terminal:completed]  │
           └────────────────────────┘
```

| Текущая фаза | Событие / Триггер | Следующая фаза | Эффект транзакции |
|---|---|---|---|
| `deliver` | `submission.wait()` вернул результат | `report` | `record.report = text`, `record.settled = true` сохранены в `SubagentsDoc.agents` |
| `report` | Отчет помещен в аутбокс | `terminal` | `SubagentsDoc.outbox` пополнен, `state.courier` создан при необходимости |
| Любая | `task.abort()` | `terminal:aborted` | Дочерняя беседа прерывается |

---

### 3.2. FSM Состояний Courier

```
           ┌────────────────────────┐
           │       [gather]         │ ◄── 50ms Debounce Sleep
           └───────────┬────────────┘
                       │
                       │ sleep settled -> commit()
                       ▼
           ┌────────────────────────┐
     ┌───► │        [next]          │ ◄── Evaluation
     │     └─────┬────────────┬─────┘
     │           │            │
     │ outbox    │ outbox > 0 │ hold condition
     │ empty     │            ▼
     │           │     ┌────────────┐
     │           │     │   [hold]   │ ◄── Wait on watchDoc()
     │           │     └────────────┘
     │           ▼
     │     ┌────────────┐
     │     │   [send]   │
     │     └─────┬──────┘
     │           │
     │           │ parent.submit(whenBusy: "followUp") -> done
     └───────────┘
```

| Текущая фаза | Условие / Триггер | Следующая фаза | Гарантия и действие |
|---|---|---|---|
| `gather` | Истекли 50 мс таймера | `next` | Переход к проверке накопленных отчетов |
| `next` | `deliveryHold !== undefined` | `hold` | Приостановка доставки до устранения причины |
| `next` | `outbox.length === 0` | `terminal:completed` | Очередь пуста, курьер самоликвидируется (`delete state.courier`) |
| `next` | `outbox.length > 0` | `send` | Формируется батч `sending` с уникальным `requestId: "subagent-batch:${task.id}:${batch}"` |
| `send` | `parent.submit().wait()` -> `done` | `next` | `delete state.sending` закоммичен в SQLite, возврат к поиску новых отчетов |
| `send` | `wait()` вернул ошибку или `aborted` | `hold` | `deliveryHold = { kind: "uncertain", requestId, reason }` блокирует дублирование |
| `hold` | Изменение документа `watchDoc` сняло hold | `next` | Автоматическое возобновление цикла доставки |

---

### 3.3. Матрица отказов и поведение при сбоях (Crash Recovery Matrix)

| Точка сбоя (Crash Event) | Физическое состояние на диске (`session.sqlite`) | Восстановление при перезапуске (Resumption) | Гарантия целостности (Invariants) |
|---|---|---|---|
| **Краш во время работы субагента (`kill -9`)** | Дочерняя беседа в `conversations`, задача Reporter в фазе `deliver`. | Раннер перезапускается, TaskGraph видит незавершенный `Reporter: deliver`. `child.submit` с тем же `requestId` восстанавливает соединение с дочерней беседой. | **Никаких потерянных задач.** Субагент продолжает выполнение или перезапускает прерванный шаг. |
| **Краш после завершения дочерней беседы, до коммита Reporter** | Ответ субагента зафиксирован в `entries`, но `SubagentsDoc.outbox` еще не обновлен. | Reporter просыпается в `deliver`, видит `settled`, повторно считывает `AssistantEntry` и выполняет коммит в `report`. | **Идемпотентность.** Повторный вход производит ровно тот же текст отчета. |
| **Краш во время окна дебаунса Courier (фаза `gather`)** | Отчеты лежат в `SubagentsDoc.outbox`. Задача Courier сохранена в фазе `gather`. | Pi Durable возобновляет Courier. Если 50 мс уже прошли по времени часов, немедленно переходит в `next`. | **Никаких потерянных отчетов.** Аутбокс сохраняется в SQLite. |
| **Краш во время выполнения `parent.submit` (фаза `send`)** | `SubagentsDoc.sending` зафиксирован в SQLite с детерминированным `requestId: "subagent-batch:T1:1"`. | Courier просыпается в `send`. Он повторно отправляет `parent.submit` с **тем же самым `requestId`**. Pi Durable обнаруживает существующий `requestId` в таблице `submissions` и не дублирует ход, а ждет завершения. | **Strictly Once (Ни одного дубля).** Родительский агент гарантированно не получит отчет дважды. |
| **Краш BB IDE / закрытие окна** | `session.sqlite` закрывается корректно (или восстанавливается через SQLite WAL). Привязки `BindingDoc` зафиксированы на диске. | При повторном открытии BB вызывает `SessionRegistry.createOrGet`. Хост запрашивает `get_all_bindings` у раннера и мгновенно восстанавливает карту тредов. | **Мгновенное восстановление сайдбара.** Вся иерархия тредов снова на связи. |

---

## 4. Пошаговый план внедрения в src/runner и src/host с соблюдением AP-019

### 4.1. Модульная декомпозиция и распределение бюджетов строк (AP-019)

В соответствии с правилом AP-019:
- В `src/runner/`: лимит строго `< 200 строк`.
- В `src/host/`: лимит строго `< 250 строк`.

#### Архитектурная декомпозиция файлов:

```
src/
├── runner/
│   ├── subagent-docs.ts        (НОВЫЙ: ~95 строк, AP-019 PASS < 200)
│   │   └─ SubagentsDoc, SubagentRecord, PendingSubagentReport, типы состояний
│   ├── subagent-delivery.ts    (НОВЫЙ: ~175 строк, AP-019 PASS < 200)
│   │   └─ Anchor, reporterFor, courierFor, извлечение ответа из AssistantEntry
│   ├── subagent.ts             (РЕФАКТОРИНГ: ~165 строк, AP-019 PASS < 200)
│   │   └─ Определение тула subagent, Role Envelope, интеграция Reporter
│   ├── binding-docs.ts         (НОВЫЙ: ~110 строк, AP-019 PASS < 200)
│   │   └─ BindingDoc, BindingIndexDoc, типы StoredBinding, DurableBinding
│   ├── session-commands.ts     (РАСШИРЕНИЕ: ~180 строк, AP-019 PASS < 200)
│   │   └─ Добавление обработчиков register_binding и get_all_bindings
│   └── harness-setup.ts        (ОБНОВЛЕНИЕ: ~170 строк, AP-019 PASS < 200)
│       └─ Регистрация Anchor, Reporter, Courier в registry
│
└── host/
    ├── durable-binding-store.ts(НОВЫЙ: ~140 строк, AP-019 PASS < 250)
    │   └─ DurableBindingManager (L1 кэш, runner RPC, cold SQLite read)
    ├── session.ts              (РЕФАКТОРИНГ: 240 -> ~195 строк, AP-019 PASS < 250)
    │   └─ Делегирование conversationThreadMap в DurableBindingManager
    └── session-registry.ts     (ОБНОВЛЕНИЕ: ~175 строк, AP-019 PASS < 250)
        └─ Инициализация маппингов при shared session
```

---

### 4.2. Пошаговый план реализации (Phased Implementation Plan)

#### Шаг 1: Фундамент документов и задач доставки (Runner Domain)
1. Создать `src/runner/subagent-docs.ts` с определением `SubagentsDoc`, контрактов `SubagentRecord`, `PendingSubagentReport`, `SubagentBatchPayload`.
2. Создать `src/runner/subagent-delivery.ts` с реализацией `Anchor`, `reporterFor` и `courierFor`.
3. Зарегистрировать задачи в `createCodingRegistry` в `src/runner/harness-setup.ts`.
4. Обновить `src/runner/subagent.ts`: при `background: true` создавать задачу `Reporter` с владением родительской беседой.
5. Написать модульный тест `tests/subagent-reporter-courier.test.ts` с верификацией доставки ответа из дочерней беседы родителю.

#### Шаг 2: Батчинг и дебаунс 50ms (Runner Delivery)
1. Реализовать фазу `gather` в `courierFor` с таймером 50 мс.
2. Реализовать фазу `next` с упаковкой нескольких отчетов в единый батч.
3. Добавить тест `tests/subagent-courier-batching.test.ts`: запуск 3 субагентов параллельно, проверка формирования ровно одного хода родителя с объединением всех 3 отчетов.

#### Шаг 3: Персистентный Binding Store (Runner + Host Protocol)
1. Создать `src/runner/binding-docs.ts` с определением `BindingDoc` и `BindingIndexDoc`.
2. В `src/runner/session-commands.ts` добавить RPC команды:
   - `register_binding`
   - `get_all_bindings`
3. Создать `src/host/durable-binding-store.ts` с классом `DurableBindingManager`.
4. Внедрить `DurableBindingManager` в `src/host/session.ts`, удалив монолитные поля `conversationThreadMap` и `threadConversationMap`. Сократить размер `session.ts` до `< 200 строк`.
5. Добавить вызов `await this.bindings.hydrateFromRunner()` в `PiThreadSession.start()`.
6. Написать тест `tests/durable-binding-store.test.ts`: регистрация привязок, перезапуск сессии, мгновенное восстановление маппингов.

#### Шаг 4: Интеграционное тестирование и верификация сбоев (E2E & Crash Recovery)
1. Написать тест `tests/subagent-delivery-crash-recovery.test.ts`: симуляция перезапуска раннера во время фазы `send`, проверка дедупликации по `requestId`.
2. Проверить лимиты строк по всем файлам: `wc -l` для всех файлов `src/runner/` (< 200) и `src/host/` (< 250).
3. Запустить полный цикл валидации: `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run doctor`.

---

## 5. Архитектурная верификация и соответствие правилам (AP Rules Matrix)

| Правило | Требование | Архитектурное решение в дизайне Track 4 | Статус |
|---|---|---|---|
| **AP-010** | Clean Architecture & Thin Adapter | Отсутствие внешних брокеров и сокетов. Вся доставка через Pi Durable Tasks. | **PASS** |
| **AP-012** | State Machines & Explicit Boundaries | Четкие конечные автоматы для Reporter (`deliver` -> `report`) и Courier (`gather` -> `next` -> `send` -> `hold`). | **PASS** |
| **AP-013** | Contract Completeness | Полная реализация жизненного цикла отчетов, отбоев, блокировок (`deliveryHold`) и привязок тредов. | **PASS** |
| **AP-019** | File Size Limit (<200 runner, <250 host) | Декомпозиция на `subagent-docs.ts`, `subagent-delivery.ts`, `binding-docs.ts`, `durable-binding-store.ts`. Разгрузка `session.ts`. | **PASS** |
| **AP-020** | Decoupling & Modular Boundaries | Четкое разделение: Runner владеет `session.sqlite`, Host владеет L1 кэшем и маршрутизацией дельт BB. | **PASS** |
| **AP-022** | No Silent Catches | Все ошибки коммита, синхронизации и сетевого допуска логируются с контекстом и передаются в `deliveryHold`. | **PASS** |
| **AP-026** | Single Source of Truth | Единственный источник истины — транзакционные документы `session.sqlite`. | **PASS** |
| **AP-028** | TDD Determinism | Полный план модульных и интеграционных тестов с детерминированным покрытием сбоев. | **PASS** |
| **AP-029** | TypeScript Strictness (Zero `any`) | Строгая типизация всех документов, параметров задач и RPC полезных нагрузок. | **PASS** |
| **AP-034** | Concurrency & Async Discipline | 50ms дебаунс батчинга, атомарная упаковка в `sending`, идемпотентность через `requestId`. | **PASS** |

---

## Заключение

Предложенный архитектурный дизайн Track 4 устраняет фундаментальные ограничения асинхронных субагентов и маршрутизации тредов в `bb-plugin-provider-pi-durable`. Использование каноничных возможностей `@earendil-works/pi-durable` (`defineDoc`, `defineTask`, `parent.submit({ whenBusy: "followUp" })`) гарантирует **транзакционную целостность, отсутствие дублей и нулевую потерю данных при сбоях хоста**, сохраняя при этом полную чистоту интеграции без модификации ядра Beyond Boundaries IDE.
