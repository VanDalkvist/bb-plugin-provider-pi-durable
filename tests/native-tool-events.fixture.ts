import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	watchEvents,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

export type NativeToolEndEvent = Extract<AgentEvent, { type: "tool_execution_end" }>;

export interface NativeCaptureResult {
	ends: NativeToolEndEvent[];
	leafEnd: NativeToolEndEvent;
	badleafEnd: NativeToolEndEvent;
	batchEnd: NativeToolEndEvent;
}

export async function captureNativeToolEnds(): Promise<NativeCaptureResult> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	const parameters = Type.Object({});

	registry.install(
		defineExtension({
			name: "contract-fixture",
			tools: [
				defineTool({
					name: "leaf",
					description: "leaf tool",
					parameters,
					execute: async () => ({
						output: [{ type: "text", text: "leaf ok" }],
						details: { diff: "-old\n+new", patch: "@@ -1 +1 @@\n-old\n+new" },
					}),
				}),
				defineTool({
					name: "badleaf",
					description: "error leaf tool",
					parameters,
					execute: async () => ({
						isError: true,
						diagnostics: [{ severity: "error", code: "fixture", message: "native failure" }],
					}),
				}),
				defineTool({
					name: "batch",
					description: "parent tool",
					parameters,
					execute: async (_, api, context) => {
						await api.executeTool("leaf", {}, context);
						await api.executeTool("badleaf", {}, context);
						return {
							output: [{ type: "text", text: "parent ok" }],
							details: { conversationId: 77 },
						};
					},
				}),
			],
		}),
	);

	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("batch", {}, { id: "c1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);

	const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	try {
		const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const ends: NativeToolEndEvent[] = [];
		const stream = await watchEvents(harness, root.id, ctx);
		stream.start(async (batch) => {
			for (const event of batch) {
				if (event.type === "tool_execution_end") {
					ends.push(event);
				}
			}
		});

		try {
			await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
			await harness.waitForIdle(ctx);
		} finally {
			await stream.stop();
		}

		const leafEnd = ends.find((e) => e.toolName === "leaf");
		const badleafEnd = ends.find((e) => e.toolName === "badleaf");
		const batchEnd = ends.find((e) => e.toolName === "batch");

		if (!leafEnd || !badleafEnd || !batchEnd) {
			throw new Error(`Expected all tool ends, got ${ends.map((e) => e.toolName).join(", ")}`);
		}

		return { ends, leafEnd, badleafEnd, batchEnd };
	} finally {
		await harness.close(ctx);
	}
}
