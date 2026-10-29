import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  type BbPluginApi,
  type PluginProviderOptionsContext,
  experimental_PluginRpcRefusal,
} from "@get-bb/plugin-sdk";
import { rpcContract } from "./src/rpc/contract.ts";
import { inspectPiEnvironment } from "./src/host/diagnostics.ts";
import { resolveSessionFilePath } from "./src/host/paths.ts";
import { SubagentPolicyStore } from "./src/policy/store.ts";
import {
  SubagentPolicyInvalidError,
  SubagentRevisionConflictError,
} from "./src/policy/errors.ts";
import { runtimeGraphSnapshotSchema } from "./src/runtime-graph/schema.ts";

export { rpcContract };

export default async function plugin(bb: BbPluginApi) {
  const store = new SubagentPolicyStore(bb.storage.kv);
  await store.hydrate();

  bb.settings.define({
    hideThinking: {
      type: "boolean",
      label: "Hide thoughts",
      description: "Hide reasoning thought blocks from the timeline entirely.",
      default: false,
    },
  });

  bb.rpc.register(rpcContract, {
    diagnostics_get: async () => {
      const report = await inspectPiEnvironment();
      return { report };
    },
    subagent_policy_get: async () => {
      return { record: store.getRecord() };
    },
    subagent_policy_set: async (input) => {
      try {
        const record = await store.setPolicy(input.policy, input.expectedRevision);
        return { record };
      } catch (error) {
        if (error instanceof SubagentRevisionConflictError) {
          throw new experimental_PluginRpcRefusal({
            code: "conflict",
            message: error.message,
          });
        }
        if (error instanceof SubagentPolicyInvalidError) {
          throw new experimental_PluginRpcRefusal({
            code: "invalid",
            message: error.message,
          });
        }
        throw error;
      }
    },
    task_abort: async (input) => {
      const sessionDir = resolveSessionFilePath(input.threadId);
      const ownerFile = join(sessionDir, "session.owner.json");
      if (!existsSync(ownerFile)) {
        throw new experimental_PluginRpcRefusal({
          code: "not_found",
          message: `Thread ${input.threadId} does not have an active session`,
        });
      }
      const controlFile = join(sessionDir, "control.jsonl");
      appendFileSync(controlFile, JSON.stringify({ type: "abort_task", taskId: input.taskId }) + "\n", "utf8");
      return { ok: true };
    },
  });

  bb.providers.register({
    id: "pi-durable",
    displayName: "Pi Durable",
    icon: "./icons/pi-durable.svg",
    deriveProviderOptions(ctx: PluginProviderOptionsContext) {
      return {
        hideThinking: Boolean(ctx?.settings?.hideThinking ?? false),
        subagentPolicy: store.getRecord(),
      };
    },
    strings: {
      signInHint: "Run `pi` on the machine to sign in.",
      expiredHint: "Your Pi session expired. Run `pi`, then reload.",
      installUrl: "https://pi.dev",
      iconTint: { light: "#10B981", dark: "#10B981" },
    },
    maintenance: { health: true, usage: false, installation: true },
    env: { passthrough: ["BB_PI_DURABLE_BRIDGE_COMMAND", "BB_PI_DURABLE_BRIDGE_ARGS"] },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: [
      { id: "none", label: "None" },
      { id: "minimal", label: "Minimal" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    experimental_nativeSkillRoots: {
      user: [
        { path: ".pi/agent/skills", recursive: true },
        { path: ".agents/skills", recursive: true },
      ],
      project: [
        { path: ".pi/skills", recursive: true },
        { path: ".agents/skills", recursive: true, ancestors: true },
      ],
    },
    experimental_resolvesNativeRoots: true,
    extensionKinds: {
      "runtime-graph": {
        state: runtimeGraphSnapshotSchema,
      },
    },
    composerActions: [],
  });
}
