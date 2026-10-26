#!/usr/bin/env node

/**
 * Entrypoint for G2 Live Transport Verification.
 * Verifies end-to-end persistence and realtime delivery of runtime graph snapshots
 * via BB's public extension state and realtime event transport.
 *
 * Exit codes:
 *   0: PASS     Live graph snapshot transport verified end-to-end
 *   1: FAILED   Verification error, schema failure, or timeout
 *   2: BLOCKED  Candidate 0.3.x not active or resident runtime unverified
 */

import { checkProviderReadiness } from "./g2-transport/readiness.mjs";
import { verifyLiveG2Transport } from "./g2-transport/verifier.mjs";

function parseArgs(args) {
	const options = {
		checkOnly: false, json: false, threadId: undefined, conversationId: undefined,
		expectedSessionId: undefined, serverUrl: process.env.BB_SERVER_URL || "http://127.0.0.1:38886", timeoutMs: 15000,
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--check-only" || arg === "--readiness") options.checkOnly = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--thread" && i + 1 < args.length) options.threadId = args[++i];
		else if (arg === "--conversation" && i + 1 < args.length) options.conversationId = Number(args[++i]);
		else if ((arg === "--expected-session" || arg === "--session") && i + 1 < args.length) options.expectedSessionId = args[++i]?.trim();
		else if (arg === "--server" && i + 1 < args.length) options.serverUrl = args[++i];
		else if (arg === "--timeout" && i + 1 < args.length) options.timeoutMs = Number(args[++i]);
	}
	return options;
}

function printHelp() {
	console.log(`\nUsage: node scripts/verify-live-g2-transport.mjs [options]\n
Options:
  --check-only, --readiness          Check if BB environment and candidate 0.3.x are ready
  --thread <id>                      Target test thread ID for live roundtrip verification
  --expected-session, --session <id> Target expected session ID for scope correlation
  --conversation <id>                Target conversation ID within composite thread
  --server <url>                     BB server base URL (default: BB_SERVER_URL or http://127.0.0.1:38886)
  --timeout <ms>                     Observation timeout in milliseconds (default: 15000)
  --json                             Emit machine-readable JSON result
  --help, -h                         Show this help message\n`);
}

function printVerdict(json, result, exitCode) {
	if (json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log("========================================================");
		console.log(`Verdict: ${result.outcome} (${result.reason})`);
		console.log("========================================================");
		console.log(`\n${result.message}\n`);
		if (result.remediation) console.log(`Next step: ${result.remediation}\n`);
	}
	process.exitCode = exitCode;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) return printHelp();
	if (options.expectedSessionId !== undefined && options.expectedSessionId.length === 0) {
		console.error("Error: --expected-session requires a non-empty string value.");
		process.exitCode = 1;
		return;
	}
	if (!options.json) {
		console.log("\n========================================================");
		console.log("       Pi Durable G2 Live Transport Verifier            ");
		console.log("========================================================\n");
		console.log(`Target Server:    ${options.serverUrl}`);
		if (options.threadId) console.log(`Target Thread:    ${options.threadId}`);
		if (options.expectedSessionId) console.log(`Expected Session: ${options.expectedSessionId}`);
	}

	const readiness = await checkProviderReadiness({ serverUrl: options.serverUrl, timeoutMs: Math.min(5000, options.timeoutMs) });

	if (!options.json) {
		console.log("\n--- 1. Provider Readiness & Version Check ---");
		console.log(`  Installed:  v${readiness.installedVersion ?? "none"} (${readiness.installed?.status ?? "unknown"})`);
		console.log(`  Candidate:  v${readiness.candidateVersion}`);
		console.log(`  Schema:     ${readiness.hasExtensionKind ? "REGISTERED" : "ABSENT"}`);
		console.log(`  Restart:    ${readiness.restart?.status ?? "unverified"}`);
		console.log(`  Runtime:    ${readiness.runtime?.status ?? "unverified"}`);
		console.log(`  Detail:     ${readiness.message}\n`);
	}

	if (!readiness.ready) {
		return printVerdict(options.json, {
			outcome: "BLOCKED", phase: "readiness", reason: readiness.reason, message: readiness.message,
			installedVersion: readiness.installedVersion, candidateVersion: readiness.candidateVersion,
			hasExtensionKind: readiness.hasExtensionKind, installed: readiness.installed, restart: readiness.restart, runtime: readiness.runtime,
			remediation: "Run cutover-to-local.sh to activate provider-pi-durable v0.3.0 in BB runtime.",
		}, 2);
	}

	if (options.checkOnly || !options.threadId) {
		return printVerdict(options.json, {
			outcome: "UNVERIFIED", phase: options.checkOnly ? "readiness" : "precheck",
			reason: options.checkOnly ? "runtime_unverified" : "missing_test_thread",
			message: options.checkOnly
				? "Installed plugin v0.3.0 is verified, but active runtime generation is unverified. Pass --thread <id> to run live test."
				: "Environment precheck passed, but no --thread <id> was passed. Pass a test thread ID.",
			installedVersion: readiness.installedVersion, candidateVersion: readiness.candidateVersion,
			installed: readiness.installed, restart: readiness.restart, runtime: readiness.runtime,
		}, 2);
	}

	if (!options.json) {
		console.log("--- 2. Live Graph Roundtrip & Realtime Subscription ---");
		console.log(`  Waiting for verified native emission on thread ${options.threadId}...`);
	}

	const result = await verifyLiveG2Transport({
		serverUrl: options.serverUrl, threadId: options.threadId, conversationId: options.conversationId,
		expectedSessionId: options.expectedSessionId, timeoutMs: options.timeoutMs, readiness,
	});

	const exitCode = result.outcome === "PASS" ? 0 : (result.outcome === "BLOCKED" || result.outcome === "UNVERIFIED" ? 2 : 1);
	printVerdict(options.json, result, exitCode);
}

main().catch((err) => {
	console.error("\n❌ Verifier fatal exception:", err);
	process.exitCode = 1;
});
