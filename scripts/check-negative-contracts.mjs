import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = ts.getParsedCommandLineOfConfigFile(resolve(root, "tsconfig.contract-tests.json"), {}, {
 ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
});
if (!config) throw new Error("CONTRACT_CONFIG_MISSING");
const target = resolve(root, "tests/types/wire.ts");
const original = readFileSync(target, "utf8");
const candidate = original.replace("@ts-expect-error", "expected-error-deliberately-unsuppressed");
if (candidate === original) throw new Error("NEGATIVE_FIXTURE_MISSING");
const host = ts.createCompilerHost(config.options), read = host.readFile.bind(host);
host.readFile = (path) => resolve(path) === target ? candidate : read(path);
const program = ts.createProgram(config.fileNames, config.options, host);
const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
const rejection = errors.find((diagnostic) => diagnostic.file?.fileName === target && diagnostic.code !== 2578);
if (!rejection) throw new Error("COMPILER_ACCEPTED_INVALID_WIRE_FIXTURE");
console.log(`Negative contract guard: actual TypeScript rejection TS${rejection.code}; source files unchanged.`);
