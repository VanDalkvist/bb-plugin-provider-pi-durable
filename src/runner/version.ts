import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function getPiDurableVersion(): string {
	try {
		const durablePkg = require.resolve("@earendil-works/pi-durable/package.json");
		if (existsSync(durablePkg)) {
			const parsed = JSON.parse(readFileSync(durablePkg, "utf8"));
			if (parsed.version) return parsed.version;
		}
	} catch {
		// intentionally ignored: package resolution fallback
	}
	try {
		const pluginPkg = join(__dirname, "..", "..", "package.json");
		if (existsSync(pluginPkg)) {
			const parsed = JSON.parse(readFileSync(pluginPkg, "utf8"));
			const dep = parsed.dependencies?.["@earendil-works/pi-durable"]?.replace(/^[\^~]/, "");
			if (dep) return dep;
		}
	} catch {
		// intentionally ignored: package resolution fallback
	}
	return "1.0.0";
}
