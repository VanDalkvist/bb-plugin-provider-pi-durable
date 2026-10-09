import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { NativeChildLaunchConfig } from "../native-child-host-contract.ts";

export type NativeRootLaunchAttestor = (durableSessionId: string, launch: NativeChildLaunchConfig) => Promise<void>;

/** A stable digest only; neither the grant nor environment contents are persisted. */
export function rootLaunchDigest(launch: NativeChildLaunchConfig): string {
	const environment = Object.fromEntries(Object.entries(launch.environment ?? {}).sort(([left], [right]) => left.localeCompare(right)));
	return createHash("sha256").update(JSON.stringify({ ...launch, environment })).digest("hex");
}

/** Atomic create-only attestation survives a worker crash before or after runner startup. */
export function createNativeRootLaunchAttestor(dataDir: string): NativeRootLaunchAttestor {
	const directory = join(resolve(dataDir), "native-root-launches");
	return async (durableSessionId, launch) => {
		const key = createHash("sha256").update(durableSessionId).digest("hex");
		const file = join(directory, `${key}.sha256`);
		const digest = rootLaunchDigest(launch);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		let handle;
		try {
			handle = await open(file, "wx", 0o600);
			await handle.writeFile(`${digest}\n`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		} finally { await handle?.close(); }
		if (await readFile(file, "utf8") !== `${digest}\n`) throw new Error("Native Durable immutable launch changed");
	};
}
