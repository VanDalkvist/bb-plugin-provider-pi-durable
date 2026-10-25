import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export function sourceGraph(root) {
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = resolve(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (/\.tsx?$/.test(file)) files.push(file);
		}
	};
	walk(resolve(root, "src"));
	const known = new Set(files);
	const graph = new Map();
	for (const file of files) {
		const imports = [];
		const add = (specifier) => {
			if (!specifier.startsWith(".")) return;
			const base = resolve(dirname(file), specifier);
			const target = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")].find((p) => known.has(p));
			if (target) imports.push(relative(root, target));
		};
		const visit = (node) => {
			if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
			if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text);
			ts.forEachChild(node, visit);
		};
		visit(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true));
		graph.set(relative(root, file), imports);
	}
	return graph;
}

export function cycles(graph) {
	let serial = 0;
	const index = new Map(), low = new Map();
	const stack = [], active = new Set(), result = [];
	const visit = (name) => {
		index.set(name, serial); low.set(name, serial++); stack.push(name); active.add(name);
		for (const next of graph.get(name) ?? []) {
			if (!index.has(next)) { visit(next); low.set(name, Math.min(low.get(name), low.get(next))); }
			else if (active.has(next)) low.set(name, Math.min(low.get(name), index.get(next)));
		}
		if (low.get(name) !== index.get(name)) return;
		const group = [];
		let entry;
		do { entry = stack.pop(); active.delete(entry); group.push(entry); } while (entry !== name);
		if (group.length > 1 || graph.get(name)?.includes(name)) result.push(group.sort());
	};
	for (const name of graph.keys()) if (!index.has(name)) visit(name);
	return result.sort((a, b) => a[0].localeCompare(b[0]));
}


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const root = resolve(process.argv[2] ?? process.cwd());
 const graph = sourceGraph(root);
 const components = cycles(graph);
 console.log(JSON.stringify({ files: graph.size, cycles: components }, null, 2));
 if (components.length) process.exitCode = 1;
}
