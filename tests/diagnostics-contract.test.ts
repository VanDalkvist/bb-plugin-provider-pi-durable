import test from "node:test";
import assert from "node:assert/strict";
import { piDiagnosticsReportSchema } from "../src/contracts/diagnostics.ts";
import { rpcContract } from "../src/rpc/contract.ts";
import { diagnosticsFixture } from "./fixtures/diagnostics.ts";

test("diagnostics report validates complete nested structure and only exports allowed fields", () => {
 const report = diagnosticsFixture();
 assert.deepEqual(piDiagnosticsReportSchema.parse(report), report);
 assert.equal("privateValue" in piDiagnosticsReportSchema.parse({ ...report, privateValue: "not-a-real-secret" }), false);
 const invalid = [
  { ...report, status: "good" },
  { ...report, paths: { agentDir: { exists: true } } },
  { ...report, models: { ...report.models, total: -1 } },
  { ...report, extensions: { ...report.extensions, errors: ["bad"] } },
  { ...report, tools: { ...report.tools, mcp: [42] } },
  { ...report, skills: { total: "0", sample: [] } },
 ];
 for (const candidate of invalid) assert.equal(piDiagnosticsReportSchema.safeParse(candidate).success, false);
});

test("active diagnostics_get uses actual structural output validation", async () => {
 const output = rpcContract.diagnostics_get.output["~standard"];
 const valid = await output.validate({ report: diagnosticsFixture() });
 assert.equal(valid.issues, undefined);
 const invalid = await output.validate({ report: { status: "healthy" } });
 assert.ok(invalid.issues?.length);
});
