import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { nativeChildHostContract } from "./src/native-child-host-contract.ts";
import { nativeChildDiscoverySignals } from "./src/native-child-discovery-contract.ts";
import { NativeServerAdmission } from "./src/native-server-admission.ts";

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: nativeChildHostContract, experimental_signals: nativeChildDiscoverySignals });
  const admission = new NativeServerAdmission(bb, host);
  bb.providers.experimental_contributeEnv("pi-durable", (context) => admission.environment(context));
  const unsubscribeDiscovery = host.experimental_onSignal("nativeChildDiscovered", ({ hostId, payload }) => admission.discovered(payload, hostId));
  const unsubscribeReady = host.experimental_onSignal("nativeRootReady", ({ hostId, payload }) => admission.rootReady(payload, hostId));
  bb.onDispose(() => { unsubscribeDiscovery(); unsubscribeReady(); });
  bb.settings?.define?.({
    hideThinking: {
      type: "boolean",
      label: "Hide thoughts",
      description: "Hide reasoning thought blocks from the timeline entirely.",
      default: false,
    },
  });

  const provider = bb.providers.register({
    id: "pi-durable",
    displayName: "Pi Durable",
    icon: "./icons/pi-durable.svg",
    deriveProviderOptions(ctx: any) {
      return {
        hideThinking: Boolean(ctx?.settings?.hideThinking ?? false),
        // Env resolver errors are swallowed by the SDK: never permit a legacy fallback.
        nativeDurableRequired: true,
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
      fork: "none", // A native fork cannot be attached without verified source transcript identity.
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: [
      { id: "none", label: "None" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    experimental_nativeSkillRoots: {
      user: [".pi/agent/skills", ".agents/skills"],
      project: [".pi/skills", ".agents/skills"],
    },
    experimental_resolvesNativeRoots: true,
    composerActions: [],
  });

  bb.onDispose?.(() => {
    provider.dispose?.();
  });
}
