export abstract class SubagentPolicyError extends Error {
  abstract readonly code: string;
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    this.cause = options?.cause;
  }
}

export class SubagentPolicyInvalidError extends SubagentPolicyError {
  readonly code = "SUBAGENT_POLICY_INVALID" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class SubagentModelUnavailableError extends SubagentPolicyError {
  readonly code = "SUBAGENT_MODEL_UNAVAILABLE" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class SubagentPolicyLoadError extends SubagentPolicyError {
  readonly code = "SUBAGENT_POLICY_LOAD_ERROR" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class SubagentRevisionConflictError extends SubagentPolicyError {
  readonly code = "REVISION_CONFLICT" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
