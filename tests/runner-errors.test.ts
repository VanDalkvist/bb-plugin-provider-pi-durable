import test from "node:test";
import assert from "node:assert/strict";
import {
	DurableHarnessError,
	DurableStorageError,
	SessionNotFoundError,
	StorageCorruptionError,
	DurableCommandError,
	InvalidCommandPayloadError,
	DurablePluginError,
} from "../src/runner/errors.ts";

test("DurableHarnessError serves as the base class with code and cause", () => {
	const cause = new Error("root cause");
	const err = new DurableHarnessError("base error", "STORAGE_ERROR", cause);
	assert.ok(err instanceof Error);
	assert.ok(err instanceof DurableHarnessError);
	assert.equal(err.name, "DurableHarnessError");
	assert.equal(err.code, "STORAGE_ERROR");
	assert.equal(err.message, "base error");
	assert.equal(err.cause, cause);
});

test("DurableStorageError and its descendants maintain hierarchy and codes", () => {
	const storageErr = new DurableStorageError("disk failure");
	assert.ok(storageErr instanceof DurableHarnessError);
	assert.equal(storageErr.code, "STORAGE_ERROR");
	assert.equal(storageErr.name, "DurableStorageError");

	const notFound = new SessionNotFoundError("session-42");
	assert.ok(notFound instanceof DurableStorageError);
	assert.ok(notFound instanceof DurableHarnessError);
	assert.equal(notFound.code, "SESSION_NOT_FOUND");
	assert.equal(notFound.sessionId, "session-42");
	assert.equal(notFound.name, "SessionNotFoundError");
	assert.ok(notFound.message.includes("session-42"));

	const corrupted = new StorageCorruptionError("db checksum mismatch");
	assert.ok(corrupted instanceof DurableStorageError);
	assert.ok(corrupted instanceof DurableHarnessError);
	assert.equal(corrupted.code, "STORAGE_CORRUPTED");
	assert.equal(corrupted.name, "StorageCorruptionError");
	assert.equal(corrupted.message, "db checksum mismatch");
});

test("DurableCommandError and descendants maintain hierarchy and codes", () => {
	const cmdErr = new DurableCommandError("dispatch failed");
	assert.ok(cmdErr instanceof DurableHarnessError);
	assert.equal(cmdErr.code, "COMMAND_ERROR");
	assert.equal(cmdErr.name, "DurableCommandError");

	const invalidPayload = new InvalidCommandPayloadError("steer", "missing delta");
	assert.ok(invalidPayload instanceof DurableCommandError);
	assert.ok(invalidPayload instanceof DurableHarnessError);
	assert.equal(invalidPayload.code, "INVALID_COMMAND_PAYLOAD");
	assert.equal(invalidPayload.command, "steer");
	assert.equal(invalidPayload.name, "InvalidCommandPayloadError");
	assert.equal(invalidPayload.message, "missing delta");
});

test("DurablePluginError maintains hierarchy and captures pluginId", () => {
	const pluginErr = new DurablePluginError("plugin-xyz", "hook crashed");
	assert.ok(pluginErr instanceof DurableHarnessError);
	assert.equal(pluginErr.code, "PLUGIN_ERROR");
	assert.equal(pluginErr.pluginId, "plugin-xyz");
	assert.equal(pluginErr.name, "DurablePluginError");
	assert.equal(pluginErr.message, "hook crashed");
});
