import type { DurableView } from "durable-zero/core";
import { jsonFixture, viewFixture } from "./durable.ts";

function createMockView(usageDoc?: unknown): DurableView {
    return {
        session: { id: "s1", directory: "/tmp/s1", cwd: "/tmp" },
        conversation: viewFixture({ conversation: {
                entries: [],
                docs: usageDoc ? { "pi.usage": jsonFixture(usageDoc) } : {},
            } }).conversation,
        conversations: [],
        models: [],
        notices: [],
    };
}
export { createMockView };
