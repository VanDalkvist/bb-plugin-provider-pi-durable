import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export function verifyBoundaries(root = process.cwd()) {
  const violations = [];
  const srcDir = resolve(root, "src");

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.tsx?$/.test(fullPath)) {
        checkFile(fullPath);
      }
    }
  };

  const checkFile = (filePath) => {
    const relFile = relative(srcDir, filePath);
    const content = readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const checkSpecifier = (specifier, line) => {
      if (!specifier.startsWith(".")) return;
      const targetPath = resolve(dirname(filePath), specifier);
      const relTarget = relative(srcDir, targetPath);

      // Rule 1: src/runner/ must NEVER import from src/host/
      if (relFile.startsWith("runner/") && relTarget.startsWith("host")) {
        violations.push({
          file: relFile,
          line,
          target: relTarget,
          rule: "AP-025: Runner must never import from Host (Sovereign Core)",
        });
      }

      // Rule 2: src/host/ must NEVER import from src/runner/
      if (relFile.startsWith("host/") && relTarget.startsWith("runner")) {
        violations.push({
          file: relFile,
          line,
          target: relTarget,
          rule: "AP-020/AP-025: Host must never import from Runner directly (Ports & Adapters)",
        });
      }

      // Rule 3: src/contracts/ must NEVER import from runner or host
      if (relFile.startsWith("contracts/") && (relTarget.startsWith("runner") || relTarget.startsWith("host"))) {
        violations.push({
          file: relFile,
          line,
          target: relTarget,
          rule: "AP-026: Contracts must be pure (no imports from runner or host)",
        });
      }

      // Rule 4: src/runtime-graph/ must NEVER import from runner or host
      if (relFile.startsWith("runtime-graph/") && (relTarget.startsWith("runner") || relTarget.startsWith("host"))) {
        violations.push({
          file: relFile,
          line,
          target: relTarget,
          rule: "AP-010: Runtime Graph schemas/scope must be pure domain",
        });
      }
    };

    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        checkSpecifier(node.moduleSpecifier.text, line);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  };

  walk(srcDir);
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const violations = verifyBoundaries(root);
  if (violations.length > 0) {
    console.error(`\x1b[31m[LAYER BOUNDARY VIOLATION] Found ${violations.length} boundary leaks:\x1b[0m`);
    for (const v of violations) {
      console.error(`  - src/${v.file}:${v.line} -> imports ${v.target} (${v.rule})`);
    }
    process.exit(1);
  } else {
    console.log(`\x1b[32m[LAYER BOUNDARY FIREWALL PASS] 0 boundary violations. Ports & Adapters cleanly respected.\x1b[0m`);
  }
}
