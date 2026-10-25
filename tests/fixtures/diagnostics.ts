import type { PiDiagnosticsReport } from "../../src/contracts/diagnostics.ts";

export function diagnosticsFixture(): PiDiagnosticsReport {
 return {
  version: "0.2.53", durableVersion: "1.3.0", agentDir: "/fixture/agent",
  paths: { agentDir: { path: "/fixture/agent", exists: true, type: "directory", required: true } },
  settings: { defaultProvider: "fixture", defaultModel: "model", thinkingLevel: "high", packages: [], extensions: [] },
  models: { total: 1, providers: ["fixture"], defaultModelAvailable: true },
  extensions: { total: 0, errors: [], warnings: [], items: [] },
  skills: { total: 0, sample: [] }, tools: { total: 1, system: ["read"], custom: [], mcp: [] },
  status: "healthy", summary: "Synthetic diagnostics fixture",
 };
}
