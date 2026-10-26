import { sessionFixture } from "../fixtures/mirror.ts";
import type { MirrorAdoptionPort } from "../../src/host/mirror-adoption.ts";
export function mirrorContracts(port: MirrorAdoptionPort) {
 sessionFixture({ registerThread: () => false });
 // @ts-expect-error registration reports a terminal boundary, not text.
 sessionFixture({ registerThread: () => "flushed" });
 // @ts-expect-error missing output operation is not a complete adoption port.
 const missing: MirrorAdoptionPort = { markConsumed: port.markConsumed, register: port.register, consumeCompleted: port.consumeCompleted };
 // @ts-expect-error prompt text is required at the host boundary.
 sessionFixture().prompt({ images: [] });
 return missing;
}
