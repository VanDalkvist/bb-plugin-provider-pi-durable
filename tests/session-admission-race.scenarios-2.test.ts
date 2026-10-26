import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("SessionRegistry: creator failure rejects all concurrent waiters deterministically and cleans up pending state", async () => {
	let shouldFail = true;
	let factoryCalls = 0;

	const registry = new SessionRegistry(
		() => {},
		() => {
			factoryCalls++;
			return sessionFixture({
				start: async () => {
					await new Promise((r) => setTimeout(r, 10));
					if (shouldFail) {
						throw new Error("SIMULATED_CREATION_FAILURE");
					}
				},
			});
		},
	);

	const results = await Promise.allSettled([
		registry.createOrGet("thr_fail", "pi_fail_1"),
		registry.createOrGet("thr_fail", "pi_fail_1"),
	]);

	assert.equal(results[0].status, "rejected");
	assert.equal(results[1].status, "rejected");
	assert.match((results[0] as PromiseRejectedResult).reason?.message, /SIMULATED_CREATION_FAILURE/);
	assert.match((results[1] as PromiseRejectedResult).reason?.message, /SIMULATED_CREATION_FAILURE/);

	assert.equal(registry.get("thr_fail"), undefined);

	shouldFail = false;
	const retrySession = await registry.createOrGet("thr_fail", "pi_fail_1");
	assert.ok(retrySession);
	assert.equal(registry.get("thr_fail"), retrySession);
});

test("SessionRegistry: independent sessions proceed concurrently without blocking each other", async () => {
	let factoryCalls = 0;
	const registry = new SessionRegistry(
		() => {},
		(options) => {
			factoryCalls++;
			return sessionFixture({
				options,
				start: async () => {
					await new Promise((r) => setTimeout(r, 15));
				},
			});
		},
	);

	const [sessA, sessB] = await Promise.all([
		registry.createOrGet("thr_a", "pi_sess_a"),
		registry.createOrGet("thr_b", "pi_sess_b"),
	]);

	assert.equal(factoryCalls, 2);
	assert.notEqual(sessA, sessB);
	assert.equal(registry.get("thr_a"), sessA);
	assert.equal(registry.get("thr_b"), sessB);
});

test("SessionRegistry: stop during in-flight creation aborts/kills session and cleans up resources", async () => {
	let killed = false;
	const mockSession = sessionFixture({
		start: async () => {
			await new Promise((r) => setTimeout(r, 50));
		},
		kill: () => {
			killed = true;
		},
	});

	const registry = new SessionRegistry(
		() => {},
		() => mockSession,
	);

	const creationPromise = registry.createOrGet("thr_abort", "pi_abort_1");
	await registry.stop("thr_abort");
	assert.equal(killed, true, "In-flight session must be killed when stopped");

	await assert.rejects(creationPromise, /SESSION_CREATION_ABORTED/);
	assert.equal(registry.get("thr_abort"), undefined);
});
