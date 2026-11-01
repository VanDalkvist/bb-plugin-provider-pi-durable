import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

test("Runner CLI: emits ready frame on stdout in standard POSIX stdio (no FD 3/4)", async () => {
	const runnerBin = resolve("dist/runner/index.js");

	const child = spawn(process.execPath, [runnerBin, "--no-session"], {
		stdio: ["pipe", "pipe", "pipe"], // strictly 3 standard descriptors!
	});

	let stdoutData = "";
	const readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(() => {
			child.kill();
			rejectPromise(new Error("Timeout waiting for ready frame on stdout"));
		}, 3000);

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutData += chunk.toString("utf8");
			for (const line of stdoutData.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed);
					if (parsed.type === "ready" || parsed.kind === "ready") {
						clearTimeout(timeout);
						child.kill();
						resolvePromise();
						return;
					}
				} catch {}
			}
		});

		child.on("error", (err) => {
			clearTimeout(timeout);
			rejectPromise(err);
		});

		child.on("exit", (code) => {
			clearTimeout(timeout);
			if (code !== 0 && code !== null) {
				rejectPromise(new Error(`Exited prematurely with code ${code}`));
			}
		});
	});

	await readyPromise;
	assert.ok(true);
});
