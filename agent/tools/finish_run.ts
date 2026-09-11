import { createHash } from "node:crypto";
import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { preparedRun } from "../lib/run-state";
import { bounded, REPOSITORY_ROOT, shellQuote } from "../lib/subject";

const PROTECTED_PATHS = [".git", ".wind-tunnel", ".github"];
const GENERATED_SEGMENTS = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	".cache",
	".astro",
	".next",
	".output",
]);

function protectedPath(relativePath: string) {
	const segments = relativePath.split("/");
	return (
		PROTECTED_PATHS.some(
			(prefix) =>
				relativePath === prefix || relativePath.startsWith(`${prefix}/`),
		) || segments.some((segment) => GENERATED_SEGMENTS.has(segment))
	);
}

export async function finalizeCandidate(ctx: Pick<ToolContext, "getSandbox">) {
	const prepared = preparedRun.get();
	if (!prepared) throw new Error("Run preparation is incomplete");
	const modelPhaseEndedAt = new Date().toISOString();
	const sandbox = await ctx.getSandbox();

	const diff = await sandbox.run({
		command: `cd ${REPOSITORY_ROOT} && git diff --binary --no-ext-diff ${shellQuote(prepared.sourceSha)} --`,
	});
	if (diff.exitCode !== 0)
		throw new Error(
			`Candidate capture failed: ${bounded(diff.stderr || diff.stdout, 20_000)}`,
		);

	const names = await sandbox.run({
		command: `cd ${REPOSITORY_ROOT} && git diff --name-only ${shellQuote(prepared.sourceSha)} --`,
	});
	if (names.exitCode !== 0) throw new Error("Changed-file capture failed");
	const changedFiles = names.stdout
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean);
	const forbidden = changedFiles.filter(protectedPath);
	if (forbidden.length)
		throw new Error(
			`Candidate patch modifies protected or generated paths: ${forbidden.join(", ")}`,
		);

	const checks = [] as Array<{
		command: string;
		passed: boolean;
		exitCode: number;
		stdout: string;
		stderr: string;
		durationMs: number;
	}>;
	for (const command of prepared.verifyCommands) {
		const started = Date.now();
		const result = await sandbox.run({
			command: `cd ${REPOSITORY_ROOT} && timeout 240s bash -lc ${shellQuote(command)}`,
		});
		checks.push({
			command,
			passed: result.exitCode === 0,
			exitCode: result.exitCode,
			stdout: bounded(result.stdout ?? "", 20_000),
			stderr: bounded(result.stderr ?? "", 20_000),
			durationMs: Date.now() - started,
		});
	}
	const passed = checks.every((check) => check.passed);

	return {
		passed,
		changedFiles,
		checks,
		patch: bounded(diff.stdout),
		patchSha256: createHash("sha256").update(diff.stdout).digest("hex"),
		timings: {
			preparationStartedAt: prepared.preparationStartedAt,
			preparationDurationMs: prepared.preparationDurationMs,
			preparation: prepared.preparationTimings,
			modelPhaseStartedAt: prepared.preparedAt,
			modelPhaseEndedAt,
			modelPhaseDurationMs:
				Date.parse(modelPhaseEndedAt) - Date.parse(prepared.preparedAt),
			verificationMs: checks.reduce((sum, check) => sum + check.durationMs, 0),
		},
		verificationIsolation: "same-worktree",
	};
}

export default defineTool({
	description:
		"Capture the git diff, run the task's deterministic verification commands, and finish the run. Call exactly once after implementation.",
	inputSchema: z.object({}),
	label: { start: () => "Capture diff and verify" },
	execute: (_input, ctx) => finalizeCandidate(ctx),
});
