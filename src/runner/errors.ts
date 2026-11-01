export type DurableErrorCode =
	| "STORAGE_ERROR"
	| "SESSION_NOT_FOUND"
	| "STORAGE_CORRUPTED"
	| "COMMAND_ERROR"
	| "INVALID_COMMAND_PAYLOAD"
	| "PLUGIN_ERROR";

export class DurableHarnessError extends Error {
	readonly code: DurableErrorCode;

	constructor(message: string, code: DurableErrorCode, cause?: unknown) {
		super(message, { cause });
		this.name = new.target.name;
		this.code = code;
	}
}

export class DurableStorageError extends DurableHarnessError {
	constructor(message: string, cause?: unknown, code: DurableErrorCode = "STORAGE_ERROR") {
		super(message, code, cause);
	}
}

export class SessionNotFoundError extends DurableStorageError {
	readonly sessionId: string;

	constructor(sessionId: string, message?: string, cause?: unknown) {
		super(message ?? `Session not found: ${sessionId}`, cause, "SESSION_NOT_FOUND");
		this.sessionId = sessionId;
	}
}

export class StorageCorruptionError extends DurableStorageError {
	constructor(message = "Storage corrupted", cause?: unknown) {
		super(message, cause, "STORAGE_CORRUPTED");
	}
}

export class DurableCommandError extends DurableHarnessError {
	constructor(message: string, cause?: unknown, code: DurableErrorCode = "COMMAND_ERROR") {
		super(message, code, cause);
	}
}

export class InvalidCommandPayloadError extends DurableCommandError {
	readonly command: string;

	constructor(command: string, message?: string, cause?: unknown) {
		super(message ?? `Invalid payload for command: ${command}`, cause, "INVALID_COMMAND_PAYLOAD");
		this.command = command;
	}
}

export class DurablePluginError extends DurableHarnessError {
	readonly pluginId: string;

	constructor(pluginId: string, message?: string, cause?: unknown) {
		super(message ?? `Plugin failure: ${pluginId}`, "PLUGIN_ERROR", cause);
		this.pluginId = pluginId;
	}
}
