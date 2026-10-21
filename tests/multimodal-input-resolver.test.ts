import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractPiPromptInput, extractInputText } from "../src/host/prompt-input.ts";

test("Multimodal Input Resolver: resolves text and localImage attachments", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-img-test-"));
	const pngPath = join(tempDir, "sample.png");
	// 1x1 transparent PNG bytes
	const pngBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAA", "base64");
	writeFileSync(pngPath, pngBuffer);

	try {
		const rawInput = [
			{ type: "text", text: "Please analyze this diagram" },
			{ type: "localImage", path: pngPath },
		];

		const resolved = extractPiPromptInput(rawInput);
		assert.ok(resolved !== null, "Expected non-null prompt input");
		assert.equal(resolved.text, "Please analyze this diagram");
		assert.equal(resolved.images.length, 1);
		assert.equal(resolved.images[0].type, "image");
		assert.equal(resolved.images[0].mimeType, "image/png");
		assert.equal(resolved.images[0].data, pngBuffer.toString("base64"));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Multimodal Input Resolver: resolves image-only input without text", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-img-only-"));
	const jpgPath = join(tempDir, "photo.jpg");
	const jpgBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
	writeFileSync(jpgPath, jpgBuffer);

	try {
		const rawInput = [{ type: "localImage", path: jpgPath }];

		const resolved = extractPiPromptInput(rawInput);
		assert.ok(resolved !== null, "Expected non-null prompt input for image-only");
		assert.equal(resolved.text, "");
		assert.equal(resolved.images.length, 1);
		assert.equal(resolved.images[0].type, "image");
		assert.equal(resolved.images[0].mimeType, "image/jpeg");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Multimodal Input Resolver: resolves data: URL image chunk", () => {
	const dataUrl = "data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA";
	const rawInput = [
		{ type: "text", text: "Here is webp:" },
		{ type: "image", url: dataUrl },
	];

	const resolved = extractPiPromptInput(rawInput);
	assert.ok(resolved !== null);
	assert.equal(resolved.text, "Here is webp:");
	assert.equal(resolved.images.length, 1);
	assert.equal(resolved.images[0].type, "image");
	assert.equal(resolved.images[0].mimeType, "image/webp");
	assert.equal(resolved.images[0].data, "UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA");
});

test("Multimodal Input Resolver: formats localFile chunks into attachment hints", () => {
	const rawInput = [
		{ type: "text", text: "Check this config" },
		{ type: "localFile", path: "/path/to/config.json", name: "config.json" },
	];

	const resolved = extractPiPromptInput(rawInput);
	assert.ok(resolved !== null);
	assert.ok(resolved.text.includes('Check this config'));
	assert.ok(resolved.text.includes('[Attached file "config.json": /path/to/config.json]'));
	assert.equal(resolved.images.length, 0);
});

test("Multimodal Input Resolver: returns null when input is empty", () => {
	const rawInput = [{ type: "text", text: "   " }];
	const resolved = extractPiPromptInput(rawInput);
	assert.equal(resolved, null);
	assert.equal(extractInputText(rawInput), "");
});
