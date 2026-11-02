import { runnerCommandSchema, type RunnerCommandPayload } from "@durable-zero/contracts";

export function commandFixture(type: RunnerCommandPayload["type"], overrides: Partial<RunnerCommandPayload> & { type?: never } = {}): RunnerCommandPayload {
 return runnerCommandSchema.parse({ ...overrides, type });
}
