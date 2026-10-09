# Reproduction: native root submission resumes before commit

This is a **memory-only SDK test**, not a live subagent. It uses the installed public `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord` packages, pure synthetic `defineTask` callbacks and one injected `MemoryStorage.mintId()` failure on a valid plain-text root input. It does **not** call `ModelRuntime.create()`, start a model/provider/application child, open a socket/process, or use persistent storage. Run from the repository root with dependencies already available; do not install/build anything solely for this draft.

```sh
awk '/^```js$/{emit=1;next} emit && /^```$/{exit} emit{print}' docs/native-durable-subagent-admission-proof.md | timeout 60s node --input-type=module -
```

Expected assertions: before submission scheduling is `paused` and no handlers have run; after the failed **pre-commit** submission, scheduling is `running`, committed root submissions are still zero, but the root, child, and sibling synthetic task handlers have each entered once. The public SDK exposes scheduling status, not an instrumented count of private `resume()` calls. A later successful retry cannot undo the earlier handler entries. SDK implementation order to inspect: `node_modules/@earendil-works/pi-durable/dist/harness/submissions.js` (`submit` resumes before `commitWith`) and `dist/harness/scheduler.js` (enabled task reservation).

```js
import assert from "node:assert/strict";
import { Harness, MemoryStorage, createRegistry, defineTask } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

class RejectNextId extends MemoryStorage {
  rejectNext = false;
  failures = 0;
  async mintId() {
    if (this.rejectNext) {
      this.rejectNext = false;
      this.failures++;
      throw new Error("injected precommit root admission failure");
    }
    return super.mintId();
  }
}

const storage = new RejectNextId();
const registry = createRegistry();
const calls = { root: 0, child: 0, sibling: 0 };
const entered = { root: [], child: [], sibling: [] };
const task = defineTask({
  name: "proof.pure", version: 1, initial: () => ({ phase: "count" }),
  phases: { count: async (record, runtime) => {
    const actor = record.input.actor;
    calls[actor]++;
    for (const signal of entered[actor].splice(0)) signal();
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "counted" } }), context);
  } },
  abort: async (_record, runtime) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
registry.install({ name: "proof-pure-extension", tasks: [task] });
const harness = await Harness.open(storage, { models: createModels(), registry }, context);
const signalFor = (actor) => new Promise(resolve => entered[actor].push(resolve));
try {
  const root = await harness.root(context);
  await root.commit(tx => tx.createTask(task, { actor: "root" }, { ownership: { kind: "conversation" } }), context);
  for (const actor of ["child", "sibling"]) {
    const child = await harness.createConversation({ ownership: { kind: "conversation", conversationId: root.id } }, context);
    await child.commit(tx => tx.createTask(task, { actor }, { ownership: { kind: "conversation" } }), context);
  }
  assert.equal((await harness.inspect(context)).scheduling, "paused");
  assert.deepEqual(calls, { root: 0, child: 0, sibling: 0 });
  const observed = Promise.all([signalFor("root"), signalFor("child"), signalFor("sibling")]);
  storage.rejectNext = true;
  await assert.rejects(root.submit({ type: "input", content: "valid plain-text root input" }, context),
    /injected precommit root admission failure/);
  assert.equal(await Promise.race([observed.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 1500))]), true,
    "restored synthetic handlers must actually enter after failed admission");
  assert.equal(storage.failures, 1);
  assert.equal(storage.state.submissions.size, 0);
  assert.equal((await harness.inspect(context)).scheduling, "running");
  assert.deepEqual(calls, { root: 1, child: 1, sibling: 1 });
  console.log(JSON.stringify({ precommitFailures: storage.failures,
    committedRootSubmissions: storage.state.submissions.size,
    scheduling: (await harness.inspect(context)).scheduling, handlerEntries: calls }, null, 2));
} finally {
  await harness.close(context);
}
```

The handler-entry count is directly observed through promises resolved at each phase start, with a bounded timeout only to fail rather than poll. This proof falsifies strict admit-before-execute under the installed SDK version; it does not claim that the adapter's full live route was exercised.
