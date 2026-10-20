# Architecture Plan - Cycle 93 Slice 4.3: Durable Binding Store (Persistent Thread Mapping in SQLite)

- **Cycle**: 93
- **Slice**: 4.3
- **Goal**: Implement persistent thread-to-conversation mapping in `bb-plugin-provider-pi-durable` so that mappings between Beyond Boundaries `bbThreadId` and Pi Durable `conversationId` are persistently stored inside `session.sqlite` (`BindingDoc` and `BindingIndexDoc`). Survives Beyond Boundaries restarts, plugin reloads (`bb plugin reload`), and ensures reliable subthread routing.
- **Primary Source / Reference**:
  - `docs/arch-improvement/cycle-93/track-4-subagents-persistence.md` §2
  - Reference implementation: `/tmp/diffuzmetall-adapter/src/store/binding-store.ts`
- **Applicable AP Gates**:
  - AP-010 (Separation of Concerns: Runner owns `session.sqlite`, Host owns L1 Cache + RPC sync)
  - AP-011 (Lifecycle Cleanup)
  - AP-013 (Deterministic event routing)
  - AP-019 (File size limits: strictly < 200 lines for all `src/runner/` files, strictly < 250 lines for all `src/host/` files)
  - AP-026 (ACID Persistence via `BindingDoc` and `BindingIndexDoc`)
  - AP-028 (TDD deterministic testing)
  - AP-029 (Strict TypeScript, zero `any`, zero unvalidated casts)

---

## Tasks Breakdown

### Task 1: Create `src/runner/binding-docs.ts` (AP-019 < 200 lines)
- Define `StoredBinding`:
  ```ts
  export interface StoredBinding {
      readonly providerId: string;
      readonly sessionId: string;
      readonly conversationId: ConversationId;
      readonly bbThreadId: string;
      readonly parentThreadId: string | null;
      readonly createdAt: number;
  }
  ```
- Define `BindingState` and `BindingIndex`.
- Define and export `BindingDoc`:
  `defineDoc<BindingState>({ kind: "bb.native-child-binding", version: 2, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ binding: null }) })`.
- Define and export `BindingIndexDoc`:
  `defineDoc<BindingIndex>({ kind: "bb.native-child-binding-index", version: 1, scope: "session", initial: () => ({ byIdentity: {}, byThreadId: {} }) })`.
- Budget: ~80 lines (< 200).

### Task 2: Create `src/runner/binding-commands.ts` (AP-019 < 200 lines)
- Implement `handleBindingCommand(cmd, durable, responder): Promise<boolean>`:
  - Command `register_binding`:
    * Expects `{ bbThreadId: string, conversationId: number, parentThreadId?: string }`.
    * Atomically commits in `durable.harness.commit`:
      - Saves `StoredBinding` into `BindingDoc` for `conversationId`.
      - Updates `BindingIndexDoc`: `byThreadId[bbThreadId] = conversationId`, `byIdentity[idKey] = conversationId`.
    * Responds with `{ success: true, command: "register_binding" }`.
  - Command `get_all_bindings`:
    * Reads snapshot of `BindingIndexDoc`.
    * For each `conversationId`, fetches `BindingDoc` and collects bindings.
    * Responds with `{ success: true, command: "get_all_bindings", data: { bindings: StoredBinding[] } }`.
- Budget: ~85 lines (< 200).

### Task 3: Wire in `src/runner/session-commands.ts`
- Delegate `register_binding` and `get_all_bindings` to `handleBindingCommand`.
- Keep `src/runner/session-commands.ts` strictly < 200 lines (AP-019).

### Task 4: Create `src/host/durable-binding-store.ts` (AP-019 < 250 lines)
- Implement `DurableBindingManager`:
  - `convToThread = new Map<string, string>()`
  - `threadToConv = new Map<string, string>()`
  - `setRpc(rpc)`
  - `register(threadId, conversationId)`: updates L1 memory maps and sends fire-and-forget `runnerRpc({ type: "register_binding", bbThreadId, conversationId })`.
  - `getThreadId(conversationId)`: reads from L1 map.
  - `getConversationId(threadId)`: reads from L1 map.
  - `hydrateFromRunner()`: requests `get_all_bindings` from runner, populates L1 maps.
  - `readOfflineBindings(sessionFilePath)`: fallback to read bindings directly from `session.sqlite` using `DatabaseSync({ readOnly: true })` if runner is offline.
- Budget: ~130 lines (< 250).

### Task 5: Refactor `src/host/session.ts`
- Replace `conversationThreadMap` and `threadConversationMap` with `this.bindings = new DurableBindingManager()`.
- Connect runner RPC to `this.bindings.setRpc(...)`.
- In `start()`: invoke `await this.bindings.hydrateFromRunner()`.
- Delegate `registerThread`, `unregisterThread`, `getThreadIdForConversation`.
- Reduce `src/host/session.ts` line count to ~195 lines (AP-019 < 250).

### Task 6: TDD Test Suite `tests/durable-binding-store.test.ts`
- Test 1: `BindingDoc` and `BindingIndexDoc` state transitions and persistence.
- Test 2: `register_binding` and `get_all_bindings` runner RPC roundtrip.
- Test 3: `DurableBindingManager` L1 cache fast read/write.
- Test 4: Hydration on session startup restores thread-to-conversation mapping.
- Test 5: Offline cold recovery reads bindings from SQLite when runner is stopped.
- Test 6: End-to-end event routing after session restart routes child deltas to the right `bbThreadId`.

### Task 7: Verification & Gate S9
- Verify `wc -l` on all touched files (< 200 runner, < 250 host).
- Run `npx tsc --noEmit` (0 errors).
- Run `npm test` (all 255+ tests green).
