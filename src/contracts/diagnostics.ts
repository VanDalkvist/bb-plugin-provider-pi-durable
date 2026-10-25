import { z } from "zod";

export const piPathStatusSchema = z.object({
 path: z.string(), exists: z.boolean(), type: z.enum(["file", "directory"]), required: z.boolean(),
});
export type PiPathStatus = z.infer<typeof piPathStatusSchema>;
export const extensionDiagnosticSchema = z.object({
 path: z.string(), resolvedPath: z.string(), tools: z.array(z.string()), commands: z.array(z.string()),
 supportedHooks: z.array(z.string()), unsupportedHooks: z.array(z.string()),
});
export type ExtensionDiagnostic = z.infer<typeof extensionDiagnosticSchema>;
const count = z.number().int().nonnegative();
const strings = z.array(z.string());
export const piDiagnosticsReportSchema = z.object({
 version: z.string(), durableVersion: z.string(), agentDir: z.string(),
 paths: z.record(z.string(), piPathStatusSchema),
 settings: z.object({
  defaultProvider: z.string().optional(), defaultModel: z.string().optional(), thinkingLevel: z.string().optional(),
  packages: strings, extensions: strings,
 }),
 models: z.object({ total: count, providers: strings, defaultModelAvailable: z.boolean() }),
 extensions: z.object({
  total: count, errors: z.array(z.object({ path: z.string(), error: z.string() })),
  warnings: z.array(z.object({ path: z.string(), warning: z.string() })), items: z.array(extensionDiagnosticSchema),
 }),
 skills: z.object({ total: count, sample: strings }),
 tools: z.object({ total: count, system: strings, custom: strings, mcp: strings }),
 status: z.enum(["healthy", "warning", "error"]), summary: z.string(),
});
export type PiDiagnosticsReport = z.infer<typeof piDiagnosticsReportSchema>;
