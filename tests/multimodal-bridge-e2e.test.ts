import type { PromptRequest } from "../src/host/prompt-request.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleTurnStart } from "../src/host/bridge-router.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import type { BridgeRouterContext } from "../src/host/bridge-router.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("Multimodal Bridge E2E: turn/start accepts image-only input without -32602 error and calls session.prompt with ImageContent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-bridge-img-"));
    const pngPath = join(tempDir, "diagram.png");
    writeFileSync(pngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAA", "base64"));
    let promptedText: any = null;
    let promptedImages: any = null;
    let promptedConvId: any = null;
    let errorSent: {
        id: any;
        code: number;
        message: string;
    } | null = null;
    let resultSent: {
        id: any;
        result: any;
    } | null = null;
    const fakeSession = sessionFixture({
        options: { threadId: "thr_test_1" },
        prompt: async ({ text, images, conversationId }: PromptRequest) => {
            promptedText = text;
            promptedImages = images;
            promptedConvId = conversationId;
        },
        registerThread: () => { return false; },
        refreshContextUsage: async () => { },
    });
    const registry = new SessionRegistry(() => { });
    registry.track("thr_test_1", fakeSession);
    const ctx: BridgeRouterContext = {
        registry,
        sendNotification: () => { },
        sendResult: (id, result) => {
            resultSent = { id, result };
        },
        sendError: (id, code, message) => {
            errorSent = { id, code, message };
        },
    };
    try {
        await handleTurnStart(1, {
            threadId: "thr_test_1",
            input: [{ type: "localImage", path: pngPath }],
        }, ctx);
        // Must NOT send error -32602
        assert.equal(errorSent, null, `Expected no error, got: ${JSON.stringify(errorSent)}`);
        assert.ok(resultSent, "Expected success result");
        // session.prompt must receive empty text and 1 image
        assert.equal(promptedText, "");
        assert.ok(Array.isArray(promptedImages));
        assert.equal(promptedImages.length, 1);
        assert.equal(promptedImages[0].type, "image");
        assert.equal(promptedImages[0].mimeType, "image/png");
    }
    finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
