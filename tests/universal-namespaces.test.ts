import test from "node:test";
import assert from "node:assert/strict";
import { DynamicCodemodeNamespaces } from "../src/runner/codemode-namespaces.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

test("DynamicCodemodeNamespaces: supports non-MCP extensions with def.namespace (BL-CM-10)", () => {
	const registry = new DynamicCodemodeNamespaces();

	const customTool: ToolDefinition = {
		name: "database_query",
		description: "Run SQL query on internal DB",
		parameters: Type.Object({ sql: Type.String() }),
		namespace: {
			name: "database",
			description: "Internal Database Operations",
			instructions: "Always wrap mutating operations in transactions.",
		},
		execute: async () => ({ content: [] }),
	};

	registry.registerFromToolDefinitions([customTool]);

	const namespaces = registry.getNamespaces();
	assert.equal(namespaces.length, 1, "Expected 1 registered namespace");

	const dbNamespace = namespaces[0];
	assert.equal(dbNamespace.name, "database");
	assert.equal(dbNamespace.description, "Internal Database Operations");
	assert.equal(dbNamespace.instructions, "Always wrap mutating operations in transactions.");
	assert.ok(dbNamespace.prefix.startsWith("database"));
});
