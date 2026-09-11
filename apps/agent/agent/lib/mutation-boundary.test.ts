import assert from "node:assert/strict";
import test from "node:test";
import { escapingSymbolHunks, parseUnifiedZeroDiff } from "./mutation-boundary";

const ranges = [
	{ file: "src/example.ts", symbol: "target", startLine: 10, endLine: 20 },
];

test("parses zero-context unified diff hunks", () => {
	assert.deepEqual(
		parseUnifiedZeroDiff(
			"diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -12,2 +12,3 @@\n-old\n+new\n+line\n",
		),
		[
			{
				file: "src/example.ts",
				oldStart: 12,
				oldCount: 2,
				newStart: 12,
				newCount: 3,
			},
		],
	);
});

test("accepts hunks contained by compiled symbol ranges", () => {
	const diff = "+++ b/src/example.ts\n@@ -12,2 +12,2 @@\n-old\n+new\n";
	assert.deepEqual(escapingSymbolHunks(diff, ranges), []);
});

test("rejects hunks outside or without compiled symbol ranges", () => {
	const diff = [
		"+++ b/src/example.ts",
		"@@ -21 +21 @@",
		"-old",
		"+new",
		"+++ b/src/other.ts",
		"@@ -1 +1 @@",
		"-old",
		"+new",
	].join("\n");
	assert.deepEqual(
		escapingSymbolHunks(diff, ranges).map((hunk) => hunk.file),
		["src/example.ts", "src/other.ts"],
	);
});
