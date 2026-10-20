import test from "node:test";
import assert from "node:assert/strict";

test("tool result preserves image blocks untouched when isError is true for upstream pi-ai@1.3.0 handling", () => {
	// In Pi 1.3.0, pi-ai natively splits error images via splitErrorToolResultImages.
	// The runner tool adapter no longer strips images or replaces them with text notes.
	const content = [
		{ type: "image", data: "base64data...", mimeType: "image/png" },
		{ type: "text", text: "Something went wrong" },
	];
	assert.strictEqual(content.length, 2);
	assert.strictEqual(content[0].type, "image");
	assert.strictEqual(content[1].type, "text");
});
