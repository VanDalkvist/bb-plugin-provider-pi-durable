import type { OwnedSessionPort, SessionRegistryPort, SessionRunnerPort } from "../../src/host/session-port.ts";
import type { SessionOptions } from "../../src/host/types.ts";
import { SubagentMirrorManager } from "../../src/host/subagent-mirror.ts";
import type { BridgeRouterContext } from "../../src/host/bridge-router.ts";

type Overrides = Omit<Partial<OwnedSessionPort>, "options" | "runner"> & {
 options?: Partial<SessionOptions>;
 runner?: Partial<SessionRunnerPort>;
};

export function sessionFixture(overrides: Overrides = {}): OwnedSessionPort {
 const mirrors = new SubagentMirrorManager();
 const bindings = new Map<string, string>();
 const options: SessionOptions = {
  threadId: "thr_fixture", providerThreadId: "fixture:1", cwd: "/fixture",
  sessionFilePath: "/fixture/session.sqlite", sessionDir: "/fixture", extensionPath: "/fixture/extension.mjs", scratchDir: "/fixture/scratch",
  ...overrides.options,
 };
 const session: OwnedSessionPort = {
  prompt: async () => { throw new Error("UNEXPECTED_FIXTURE_PROMPT"); },
  steer: async () => { throw new Error("UNEXPECTED_FIXTURE_STEER"); },
  abort: async () => {}, compact: async () => {}, refreshContextUsage: async () => {},
  getLastCheckpointId: () => null,
  registerThread: (threadId, id) => { if (id) bindings.set(threadId, id); return false; },
  unregisterThread: (threadId) => { bindings.delete(threadId); },
  getConversationIdForThread: (threadId) => bindings.get(threadId),
  getSubagentState: (id) => mirrors.getState(id),
  findSubagentConversationForTask: (task) => mirrors.findConversationForTask(task),
  getMirrorOutputText: (id) => session.getSubagentState(id)?.result ?? "",
  markInitialMirrorTurnConsumed: (id) => { const state = session.getSubagentState(id); if (state) state.initialTurnConsumed = true; },
  consumeCompletedMirror: (id) => mirrors.consumeCompleted(id),
  setModel: async (provider, id) => { options.model = { provider, id }; },
  setThinkingLevel: async (level) => { options.thinkingLevel = level; },
  setSubagentPolicy: async () => {},
  getAcknowledgedSubagentPolicyRevision: () => undefined,
  start: async () => {}, closeGracefully: async () => {}, kill: () => {},
  ...overrides,
  options,
  runner: { exited: false, requestOk: async () => { throw new Error("UNEXPECTED_FIXTURE_RPC"); }, ...overrides.runner },
 };
 return session;
}

export function contextFixture(overrides: Partial<BridgeRouterContext> & { registry: SessionRegistryPort }): BridgeRouterContext {
 return { sendNotification: () => {}, sendResult: () => {},
  sendError: () => { throw new Error("UNEXPECTED_FIXTURE_ROUTER_ERROR"); }, ...overrides };
}

export function registryFixture(overrides: Partial<SessionRegistryPort> = {}): SessionRegistryPort {
 return {
  get: () => undefined,
  createOrGet: async () => { throw new Error("UNREGISTERED_FIXTURE_SESSION"); },
  reconcileCwd: async () => undefined,
  stop: async () => {},
  ...overrides,
 };
}
