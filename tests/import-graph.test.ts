import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { sourceGraph, cycles } from "../scripts/verify-import-graph.mjs";

test("local source graph is acyclic including type-only imports", () => {
	const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
	assert.deepEqual(cycles(sourceGraph(root)), []);
});

test("cycle oracle catches type-only SCC and self import, not a DAG", () => {
	assert.deepEqual(cycles(new Map([["a", ["b"]], ["b", ["a"]]])), [["a", "b"]]);
	assert.deepEqual(cycles(new Map([["a", ["a"]]])), [["a"]]);
	assert.deepEqual(cycles(new Map([["a", ["b"]], ["b", []]])), []);
});
