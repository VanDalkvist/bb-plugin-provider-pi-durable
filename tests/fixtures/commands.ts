import { runnerCommandSchema, type RunnerCommandPayload } from "../../src/contracts/runner-command.ts";

export function commandFixture(type: RunnerCommandPayload["type"], overrides: Partial<RunnerCommandPayload> & { type?: never } = {}): RunnerCommandPayload {
 return runnerCommandSchema.parse({ ...overrides, type });
}
