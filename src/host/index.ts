import {
	experimental_defineHostEntry,
	experimental_nativeRootsHostContract,
	experimental_filterResolvedNativeRoots,
} from "@get-bb/plugin-sdk/host";
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { homedir } from "node:os";
import { ProviderBridge } from "./bridge.ts";

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

export default experimental_defineHostEntry({
	contract: experimental_nativeRootsHostContract,
	handlers: {
		resolveNativeRoots: () => {
			return { skills: [] };
		},
	},
});
