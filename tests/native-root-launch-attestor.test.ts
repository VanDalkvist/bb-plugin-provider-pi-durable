import assert from "node:assert/strict";
import { it } from "node:test";
import { rootLaunchDigest } from "../src/host/native-root-launch-attestor.ts";

const root = {
  cwd: "/memory/workspace", sessionDirectory: "/memory/session", durableSessionId: "session",
  model: { provider: "provider", modelId: "model" }, thinking: "high",
  appendSystemPrompt: "trusted BB instruction", environment: { B: "b", A: "a" },
};

it("attests only a digest of the complete immutable root launch, independent of environment insertion order", () => {
  const fingerprint = rootLaunchDigest(root);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(fingerprint, rootLaunchDigest({ ...root, environment: { A: "a", B: "b" } }));
  assert.notEqual(fingerprint, rootLaunchDigest({ ...root, environment: { A: "changed", B: "b" } }));
  assert.notEqual(fingerprint, rootLaunchDigest({ ...root, model: { provider: "provider", modelId: "different" } }));
  assert.notEqual(fingerprint, rootLaunchDigest({ ...root, thinking: "low" }));
  assert.notEqual(fingerprint, rootLaunchDigest({ ...root, appendSystemPrompt: "different" }));
  assert.notEqual(fingerprint, rootLaunchDigest({ ...root, cwd: "/memory/other" }));
});
