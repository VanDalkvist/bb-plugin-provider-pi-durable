import { viewFixture, viewSourceFixture, taskNodeFixture } from "../fixtures/durable.ts";
export function durableContracts() {
 const view = viewFixture();
 viewSourceFixture({ current: () => view, subscribe: () => () => {} });
 // @ts-expect-error a view source must own its subscription lifetime.
 viewSourceFixture({ current: () => view });
 // @ts-expect-error conversation entries cannot be omitted by replacing the view with another shape.
 viewFixture({ conversation: { entries: "not entries" } });
 // @ts-expect-error native task status is not an invented lifecycle label.
 taskNodeFixture({ id: 1, conversationId: 1, kind: "fixture", background: false, abortRequested: false, conversations: [], state: { status: "finished" } });
}
