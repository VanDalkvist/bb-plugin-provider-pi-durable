export class SessionCreationAbortedError extends Error {
	public readonly code = "SESSION_CREATION_ABORTED";
	constructor(message = "SESSION_CREATION_ABORTED") {
		super(message);
		this.name = "SessionCreationAbortedError";
	}
}

export class SessionIdentityMismatchError extends Error {
	public readonly code = "SESSION_IDENTITY_MISMATCH";
	constructor(message: string) {
		super(message);
		this.name = "SessionIdentityMismatchError";
	}
}

export class SessionOwnerConflictError extends Error {
	public readonly code = "SESSION_OWNER_CONFLICT";
	constructor(message = "SESSION_OWNER_CONFLICT") {
		super(message);
		this.name = "SessionOwnerConflictError";
	}
}
