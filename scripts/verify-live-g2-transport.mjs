#!/usr/bin/env node

/**
 * Entrypoint for G2 Live Transport Verification.
 * Verifies end-to-end persistence and realtime delivery of runtime graph snapshots
 * via BB's public extension state and realtime event transport.
 *
 * Exit codes:
 *   0: PASS (live transport verified)
 *   1: FAILED (verification failed / timed out)
 *   2: BLOCKED (candidate 0.3.x not active, cutover required)
 */

import { checkProviderReadiness } from "./g2-transport/readiness.mjs";
import { verifyLiveG2Transport } from "./g2-transport/verifier.mjs";

function parseArgs(args) {
	const options = {
		checkOnly: false,
		json: false,
		threadId: undefined,
		conversationId: undefined,
		serverUrl: process.env.BB_SERVER_URL || "http://127.0.0.1:38886",
		timeoutMs: 15000,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--check-only" || arg === "--readiness") {
			options.checkOnly = true;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--thread" && i + 1 < args.length) {
			options.threadId = args[++i];
		} else if (arg === "--conversation" && i + 1 < args.length) {
			options.conversationId = Number(args[++i]);
		} else if (arg === "--server" && i + 1 < args.length) {
			options.serverUrl = args[++i];
		} else if (arg === "--timeout" && i + 1 < args.length) {
			options.timeoutMs = Number(args[++i]);
		}
	}

	return options;
}

function printHelp() {
	console.log(`
Usage: node scripts/verify-live-g2-transport.mjs [options]

Options:
  --check-only, --readiness   Check if BB environment and candidate 0.3.x are ready
  --thread <id>               Target test thread ID for live roundtrip verification
  --conversation <id>         Target conversation ID within composite thread
  --server <url>              BB server base URL (default: BB_SERVER_URL or http://127.0.0.1:38886)
  --timeout <ms>              Observation timeout in milliseconds (default: 15000)
  --json                      Emit machine-readable JSON result
  --help, -h                  Show this help message

Exit codes:
  0: PASS     Live graph snapshot transport verified end-to-end
  1: FAILED   Verification error, schema failure, or timeout
  2: BLOCKED  Candidate 0.3.x not active in BB runtime (requires local cutover)
`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));

	if (options.help) {
		printHelp();
		return;
	}

	if (!options.json) {
		console.log("\n========================================================");
		console.log("       Pi Durable G2 Live Transport Verifier            ");
		console.log("========================================================\n");
		console.log(`Target Server: ${options.serverUrl}`);
		if (options.threadId) console.log(`Target Thread: ${options.threadId}`);
	}

	const readiness = await checkProviderReadiness({
		serverUrl: options.serverUrl,
		timeoutMs: Math.min(5000, options.timeoutMs),
	});

	if (!options.json) {
		console.log("\n--- 1. Provider Readiness & Version Check ---");
		console.log(`  Installed Version: ${readiness.installedVersion ?? "none"}`);
		console.log(`  Candidate Target:  ${readiness.candidateVersion}`);
		console.log(`  Extension Schema:  ${readiness.hasExtensionKind ? "REGISTERED" : "ABSENT"}`);
		console.log(`  Readiness Status:  ${readiness.outcome}`);
		console.log(`  Detail:            ${readiness.message}\n`);
	}

	if (!readiness.ready) {
		const result = {
			outcome: "BLOCKED",
			phase: "readiness",
			reason: readiness.reason,
			message: readiness.message,
			installedVersion: readiness.installedVersion,
			candidateVersion: readiness.candidateVersion,
			hasExtensionKind: readiness.hasExtensionKind,
			remediation: "Run cutover-to-local.sh to activate provider-pi-durable v0.3.0 in BB runtime.",
		};

		if (options.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log("========================================================");
			console.log("Verdict: BLOCKED (Candidate 0.3.x not active in runtime)");
			console.log("========================================================");
			console.log(`\nNext step: ${result.remediation}\n`);
		}
		process.exitCode = 2;
		return;
	}

	if (options.checkOnly || !options.threadId) {
		const result = {
			outcome: options.checkOnly ? "READY" : "BLOCKED",
			phase: options.checkOnly ? "readiness" : "precheck",
			reason: options.checkOnly ? "ok" : "missing_test_thread",
			message: options.checkOnly
				? "Environment is READY for live G2 verification. Provide --thread <id> to run live test."
				: "Environment is ready but no --thread <id> was passed. Pass a test thread ID.",
			installedVersion: readiness.installedVersion,
			candidateVersion: readiness.candidateVersion,
		};

		if (options.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log("========================================================");
			console.log(`Verdict: ${result.outcome}`);
			console.log("========================================================");
			console.log(`\n${result.message}\n`);
		}
		process.exitCode = options.checkOnly ? 0 : 2;
		return;
	}

	if (!options.json) {
		console.log("--- 2. Live Graph Roundtrip & Realtime Subscription ---");
		console.log(`  Waiting for real extension.state on thread ${options.threadId}...`);
	}

	const verificationResult = await verifyLiveG2Transport({
		serverUrl: options.serverUrl,
		threadId: options.threadId,
		conversationId: options.conversationId,
		timeoutMs: options.timeoutMs,
		readiness,
	});

	if (options.json) {
		console.log(JSON.stringify(verificationResult, null, 2));
	} else {
		console.log("\n========================================================");
		console.log(`Verdict: ${verificationResult.outcome} (${verificationResult.reason})`);
		console.log("========================================================");
		console.log(`\n${verificationResult.message}\n`);
	}

	if (verificationResult.outcome === "PASS") {
		process.exitCode = 0;
	} else if (verificationResult.outcome === "BLOCKED") {
		process.exitCode = 2;
	} else {
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error("\n❌ Verifier fatal exception:", err);
	process.exitCode = 1;
});
