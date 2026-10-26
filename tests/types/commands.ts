import { commandFixture } from "../fixtures/commands.ts";
export function commandContracts() {
 commandFixture("prompt", { images: [{ type: "image", data: "test", mimeType: "image/png" }] });
 // @ts-expect-error unknown native commands are not accepted.
 commandFixture("make_up_a_command", {});
 // @ts-expect-error image MIME is a required DTO field.
 commandFixture("prompt", { images: [{ type: "image", data: "test" }] });
 // @ts-expect-error reasoning levels come from the closed command schema.
 commandFixture("set_thinking_level", { level: "ultra" });
}
