import type { MutationRange } from "./run-state";

export type DiffHunk = {
	file: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
};

export function parseUnifiedZeroDiff(diff: string) {
	const hunks: DiffHunk[] = [];
	let file: string | null = null;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++ b/")) {
			file = line.slice(6);
			continue;
		}
		if (!file || !line.startsWith("@@ ")) continue;
		const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		if (!match) continue;
		hunks.push({
			file,
			oldStart: Number(match[1]),
			oldCount: Number(match[2] ?? "1"),
			newStart: Number(match[3]),
			newCount: Number(match[4] ?? "1"),
		});
	}
	return hunks;
}

function hunkInsideRange(hunk: DiffHunk, range: MutationRange) {
	if (hunk.file !== range.file) return false;
	if (hunk.oldCount === 0) {
		const insertionAfterLine = Math.max(1, hunk.oldStart);
		return (
			insertionAfterLine >= range.startLine - 1 &&
			insertionAfterLine <= range.endLine
		);
	}
	const oldEnd = hunk.oldStart + hunk.oldCount - 1;
	return hunk.oldStart >= range.startLine && oldEnd <= range.endLine;
}

export function escapingSymbolHunks(diff: string, ranges: MutationRange[]) {
	if (!ranges.length) return [];
	return parseUnifiedZeroDiff(diff).filter(
		(hunk) => !ranges.some((range) => hunkInsideRange(hunk, range)),
	);
}
