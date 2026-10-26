import { wireFixture } from "../fixtures/wire.ts";
export function wireContracts() {
 wireFixture("tool_execution_end", { isError: true, result: "failed" });
 // @ts-expect-error a boolean result flag cannot become a string.
 wireFixture("tool_execution_end", { isError: "true" });
 // @ts-expect-error tool names remain strings despite extensible metadata.
 wireFixture("tool_execution_start", { toolName: 42 });
 // @ts-expect-error event discriminators are not arbitrary strings.
 wireFixture("unknown_event", {});
 // @ts-expect-error nested content index is required by the wire schema.
 wireFixture("message_update", { assistantMessageEvent: { type: "text_delta", delta: "x" } });
}
