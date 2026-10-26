import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("registry ownership tracking uses typed session ports without private map reflection", async () => {
 const registry = new SessionRegistry(() => {});
 const session = sessionFixture({ options: { threadId: "thr_owner", providerThreadId: "fixture:1" } });
 registry.track("thr_owner", session);
 assert.equal(registry.get("thr_owner"), session);
 assert.equal(await registry.createOrGet("thr_owner", "fixture:1"), session);
 await registry.stop("thr_owner");
 assert.equal(registry.get("thr_owner"), undefined);
});

test("registry tracking refuses replacing a different live owner", () => {
 const registry = new SessionRegistry(() => {});
 const first = sessionFixture(), second = sessionFixture();
 registry.track("thr_owner", first);
 registry.track("thr_owner", first);
 assert.throws(() => registry.track("thr_owner", second), /SESSION_OWNER_CONFLICT/);
 assert.equal(registry.get("thr_owner"), first);
});
