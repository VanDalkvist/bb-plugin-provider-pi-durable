import test from "node:test";
import assert from "node:assert/strict";
import { RunnerProcess } from "../src/host/runner-process.ts";

test("RunnerProcess: sequential FIFO dispatch of onEvent preserves message ordering", { timeout: 2000 }, async () => {
	const order: string[] = [];

	const proc = new RunnerProcess({
		command: process.execPath,
		args: ["-e", "process.stdin.resume()"],
		onEvent: async (event: any) => {
			if (event.type === "slow_event") {
				await new Promise((r) => setTimeout(r, 20));
				order.push("slow_event:done");
			} else if (event.type === "fast_event") {
				order.push("fast_event:done");
			}
		},
	});

	try {
		proc.handleIncoming({ type: "slow_event" } as any);
		proc.handleIncoming({ type: "fast_event" } as any);

		await proc.waitForEvents();

		assert.deepEqual(order, ["slow_event:done", "fast_event:done"], "Events must settle strictly in arrival order");
	} finally {
		proc.kill();
		(proc as any).child?.kill?.("SIGKILL");
		(proc as any).child?.unref?.();
	}
});
