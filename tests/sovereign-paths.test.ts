import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureSessionDirectory, resolveSessionDir, resolveSessionFilePath } from "../src/host/paths.ts";
import { DurableStorageError } from "../src/runner/errors.ts";

test("resolveSessionDir: defaults strictly to ~/.durable/sessions with zero fallback to ~/.bb", () => {
	// Empty env defaults strictly to ~/.durable/sessions
	const defaultDir = resolveSessionDir({});
	assert.equal(defaultDir, join(homedir(), ".durable", "sessions"));

	// Zero fallback even when BB_DATA_DIR or legacy variables are present
	const noBbFallback = resolveSessionDir({ BB_DATA_DIR: "/some/foreign/bb" });
	assert.equal(noBbFallback, join(homedir(), ".durable", "sessions"));
});

test("resolveSessionDir: honors DURABLE_SESSIONS_DIR and transitional override", () => {
	// DURABLE_SESSIONS_DIR override
	const customDurable = resolveSessionDir({ DURABLE_SESSIONS_DIR: "/custom/durable/path" });
	assert.equal(customDurable, resolve("/custom/durable/path"));

	// Transitional BB_PI_BRIDGE_SESSION_DIR override
	const transitional = resolveSessionDir({ BB_PI_BRIDGE_SESSION_DIR: "/transitional/sessions" });
	assert.equal(transitional, resolve("/transitional/sessions"));

	// DURABLE_SESSIONS_DIR takes precedence over transitional
	const precedence = resolveSessionDir({
		DURABLE_SESSIONS_DIR: "/primary/durable",
		BB_PI_BRIDGE_SESSION_DIR: "/secondary/transitional",
	});
	assert.equal(precedence, resolve("/primary/durable"));
});

test("ensureSessionDirectory: creates directories with mode 0o700", () => {
	const tempBase = mkdtempSync(join(tmpdir(), "pi-durable-sovereign-ensure-"));
	try {
		const targetDir = join(tempBase, "nested", "session-dir");
		const created = ensureSessionDirectory(targetDir);
		assert.equal(created, targetDir);
		assert.equal(existsSync(targetDir), true);

		// Verify 0o700 permissions (POSIX user rwx only)
		const stat = statSync(targetDir);
		assert.equal(stat.mode & 0o777, 0o700);
	} finally {
		rmSync(tempBase, { recursive: true, force: true });
	}
});

test("resolveSessionFilePath: validates, sanitizes, and creates directory with 0o700", () => {
	const tempBase = mkdtempSync(join(tmpdir(), "pi-durable-sovereign-resolve-"));
	try {
		const env = { DURABLE_SESSIONS_DIR: tempBase };
		const sessionPath = resolveSessionFilePath("thr:feature*test#1", env);

		assert.equal(sessionPath, join(tempBase, "thr_feature_test_1"));
		assert.equal(existsSync(sessionPath), true);

		const stat = statSync(sessionPath);
		assert.equal(stat.mode & 0o777, 0o700);
	} finally {
		rmSync(tempBase, { recursive: true, force: true });
	}
});

test("resolveSessionFilePath: path traversal detection throws DurableStorageError", () => {
	const testCases = [
		"a/../b",
		"../../etc/passwd",
		"../escape",
		"/absolute/path/attempt",
		"\\windows\\absolute",
		"..",
		"",
	];

	for (const candidate of testCases) {
		assert.throws(
			() => resolveSessionFilePath(candidate),
			(err: unknown) => {
				assert.ok(err instanceof DurableStorageError, `Expected DurableStorageError for "${candidate}"`);
				assert.equal(err.code, "STORAGE_ERROR");
				assert.match(err.message, /Path traversal rejected/);
				return true;
			},
			`Failed to reject path traversal for "${candidate}"`,
		);
	}
});
