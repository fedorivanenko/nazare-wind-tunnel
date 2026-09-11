import { createHash } from "node:crypto";
import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { preparedRun } from "../lib/run-state";
import { bounded, shellQuote } from "../lib/subject";

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
	const root = shellQuote(prepared.repositoryRoot);

	const diff = await sandbox.run({
		command: `cd ${root} && git diff --binary --no-ext-diff ${shellQuote(prepared.sourceSha)} --`,
	});
	if (diff.exitCode !== 0)
		throw new Error(
			`Candidate capture failed: ${bounded(diff.stderr || diff.stdout, 20_000)}`,
		);

	const names = await sandbox.run({
		command: `cd ${root} && git diff --name-only ${shellQuote(prepared.sourceSha)} --`,
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

	await sandbox.setNetworkPolicy({ allow: ["registry.npmjs.org"] });
	const checks = [] as Array<{
		command: string;
		passed: boolean;
		exitCode: number;
		stdout: string;
		stderr: string;
		durationMs: number;
	}>;
	try {
		for (const command of prepared.verifyCommands) {
			const started = Date.now();
			const result = await sandbox.run({
				command: `cd ${root} && CI=1 timeout 240s bash -lc ${shellQuote(command)}`,
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
	} finally {
		await sandbox.setNetworkPolicy("deny-all");
	}
	const passed = checks.every((check) => check.passed);
	const result = {
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

	return result;
}

export default defineTool({
	description:
		"Capture the git diff and run deterministic verification. If checks fail, fix the candidate and call finish_run again.",
	inputSchema: z.object({}),
	label: { start: () => "Capture diff and verify" },
	execute: (_input, ctx) => finalizeCandidate(ctx),
});
