import {
	experimental_defineHostEntry,
	experimental_nativeRootsHostContract,
	experimental_filterResolvedNativeRoots,
} from "@get-bb/plugin-sdk/host";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { homedir } from "node:os";
import { ProviderBridge } from "./bridge.ts";
import { nativeChildHostContract } from "../native-child-host-contract.ts";
import { nativeChildDiscoverySignals } from "../native-child-discovery-contract.ts";
import { createNativeChildHostHandlers } from "./native-child-host-service.ts";

const bridge = new ProviderBridge((line) => {
	process.stdout.write(line);
});

export const experimental_providerBridge = experimental_defineProviderBridge({
	handleLine: (line: string) => {
		bridge.handleLine(line);
	},
	onClose: () => {
		bridge.shutdown().finally(() => process.exit(0));
	},
	onSigterm: () => {
		bridge.shutdown().finally(() => process.exit(0));
	},
	onSigint: () => {
		bridge.shutdown().finally(() => process.exit(0));
	},
});

const nativeChildHandlers = createNativeChildHostHandlers();

export default experimental_defineHostEntry({
	contract: defineRpcContract({ ...experimental_nativeRootsHostContract, ...nativeChildHostContract }),
	experimental_signals: nativeChildDiscoverySignals,
	handlers: {
		resolveNativeRoots: () => {
			return { skills: [] };
		},
		...nativeChildHandlers.handlers,
	},
	dispose: nativeChildHandlers.dispose,
});
