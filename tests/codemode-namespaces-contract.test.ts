import test from "node:test";
import assert from "node:assert/strict";
import { DynamicCodemodeNamespaces } from "../src/runner/codemode-namespaces.ts";

test("DynamicCodemodeNamespaces preserves distinct description and instructions", () => {
	const dynamicNs = new DynamicCodemodeNamespaces();

	dynamicNs.registerFromToolDefinitions([
		{
			name: "mcp__github__search_repos",
			namespace: {
				name: "github",
				description: "GitHub API operations",
				instructions: "Always prefer gh search before web lookup.",
			},
		},
	]);

	const list = dynamicNs.getNamespaces();
	assert.equal(list.length, 1);
	const ns = list[0]!;
	assert.equal(ns.name, "github");
	assert.equal(ns.prefix, "mcp__github__");
	assert.equal(ns.description, "GitHub API operations");
	assert.equal(ns.instructions, "Always prefer gh search before web lookup.");
});

test("DynamicCodemodeNamespaces updates existing namespace with richer instructions", () => {
	const dynamicNs = new DynamicCodemodeNamespaces();

	// First registration has no instructions
	dynamicNs.registerFromToolDefinitions([
		{
			name: "mcp__gbrain__query",
			namespace: {
				name: "gbrain",
				description: "Knowledge base",
			},
		},
	]);

	// Second registration provides instructions
	dynamicNs.registerFromToolDefinitions([
		{
			name: "mcp__gbrain__remember",
			namespace: {
				name: "gbrain",
				description: "Knowledge base",
				instructions: "Save 1 fact per call with provenance.",
			},
		},
	]);

	const list = dynamicNs.getNamespaces();
	assert.equal(list.length, 1);
	const ns = list[0]!;
	assert.equal(ns.description, "Knowledge base");
	assert.equal(ns.instructions, "Save 1 fact per call with provenance.");
});
