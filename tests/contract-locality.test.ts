import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Durable read contracts are imported directly, not through runtime composition root", () => {
 for (const file of ["subagent-watcher.ts", "bridge/bb-event-adapter.ts", "bridge/bb-child-event-adapter.ts", "bridge/turn-summary.ts", "bridge/assistant-message-builder.ts", "bridge/tool-args-resolver.ts"]) {
  const source = readFileSync(new URL("../src/runner/" + file, import.meta.url), "utf8");
  assert.doesNotMatch(source, /import type .*DurableView.*from ["'][^"']*runtime\.ts["']/);
 }
});
