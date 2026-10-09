import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { NativeChildRouteSchema, OrdinaryRootRouteSchema } from "./native-child-contract.ts";
import { NativeChildIntentProofSchema } from "./runner/native-child-inspection.ts";
import { NativeChildDiscoverySchema } from "./native-child-discovery-contract.ts";

export const NativeChildIntentHostRequestSchema = z.object({
	durableSessionId: z.string().min(1).max(512),
	parentThreadId: z.string().min(1).max(512),
	childConversationId: z.number().int().safe().nonnegative(),
	taskId: z.number().int().safe().nonnegative(),
}).strict();

/** Trusted server preparation carries the exact session-storage locator; the host derives its basename identity. */
const launchSchema = z.object({
	cwd: z.string().min(1).max(4096),
	sessionDirectory: z.string().min(1).max(4096),
	model: z.object({ provider: z.string().min(1), modelId: z.string().min(1) }).strict().optional(),
	appendSystemPrompt: z.string().min(1).max(16384).optional(),
	thinking: z.string().min(1).max(64).optional(),
	environment: z.record(z.string(), z.string()).optional(),
}).strict();

export const NativeRootConfigureSchema = z.object({
	cwd: z.string().min(1).max(4096),
	model: z.object({ provider: z.string().min(1).max(512), modelId: z.string().min(1).max(512) }).strict(),
	thinking: z.string().min(1).max(64),
	appendSystemPrompt: z.string().min(1).max(16384).optional(),
	environment: z.record(z.string().min(1).max(256), z.string().max(8192)),
}).strict();

export const nativeChildHostContract = defineRpcContract({
	resolveSessionLocation: {
		input: z.object({ providerThreadId: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u) }).strict(),
		output: z.object({ durableSessionId: z.string().min(1), sessionDirectory: z.string().min(1) }).strict(),
	},
	rootReadiness: {
		input: z.object({ parentThreadId: z.string().min(1).max(512), durableSessionId: z.string().min(1).max(512) }).strict(),
		output: z.object({ ready: z.boolean(), generation: z.number().int().nonnegative() }).strict(),
	},
	discoverNativeChildren: {
		experimental_description: "Read-only one-shot discovery after root admission; never submits child work.",
		input: z.object({ parentThreadId: z.string().min(1).max(512), durableSessionId: z.string().min(1).max(512), generation: z.number().int().positive() }).strict(),
		output: z.array(NativeChildDiscoverySchema).max(1000),
	},
	inspectNativeChildIntent: {
		experimental_description: "Read-only pre-submit native ownership proof; does not issue a view grant, submit, or execute child work.",
		input: NativeChildIntentHostRequestSchema,
		output: NativeChildIntentProofSchema,
	},
	prepareRoot: {
		experimental_description: "Stage a scoped root grant without opening or resuming Durable; bridge configures before attaching.",
		input: z.object({ route: OrdinaryRootRouteSchema, durableSessionId: z.string().min(1), launch: launchSchema.pick({ cwd: true, sessionDirectory: true }) }).strict(),
		output: z.object({ endpoint: z.string().min(1), credential: z.string().min(1), generation: z.literal(0), phase: z.literal("pending") }).strict(),
	},
	registerNativeChild: {
		experimental_description: "Verify and register one existing native child view without creating or submitting work.",
		input: z.object({ route: NativeChildRouteSchema }).strict(),
		output: z.object({ endpoint: z.string().min(1), credential: z.string().min(1), generation: z.number().int().positive() }).strict(),
	},
});

export type NativeChildHostContract = typeof nativeChildHostContract;
export type NativeChildIntentHostRequest = z.infer<typeof NativeChildIntentHostRequestSchema>;
export type NativeChildLaunchConfig = z.infer<typeof launchSchema>;
export type NativeRootConfigure = z.infer<typeof NativeRootConfigureSchema>;
export type NativeChildViewDescriptor = { readonly endpoint: string; readonly credential: string; readonly generation: number };
export const NATIVE_CHILD_ROUTE_ENV = "BB_PI_DURABLE_VIEW_ROUTE";
export const NATIVE_CHILD_SOCKET_ENV = "BB_PI_DURABLE_HOST_SOCKET";
export const NATIVE_CHILD_CREDENTIAL_ENV = "BB_PI_DURABLE_VIEW_CREDENTIAL";
