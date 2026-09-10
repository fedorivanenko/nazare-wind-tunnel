import { createHash } from "node:crypto";
import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { resolveEvaluator } from "../lib/evaluators";
import { escapingSymbolHunks } from "../lib/mutation-boundary";
import { preparedRun } from "../lib/run-state";
import {
	bounded,
	parseExperiment,
	REPOSITORY_ROOT,
	requiredText,
} from "../lib/subject";
import { runVerificationPlan } from "../lib/verification-plan";

const PROTECTED_PATHS = [".git", ".wind-tunnel", "experiments", ".github"];
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

function insideAnyPath(file: string, allowedPaths: string[]) {
	return allowedPaths.some(
		(prefix) => file === prefix || file.startsWith(`${prefix}/`),
	);
}

export async function finalizeCandidate(ctx: Pick<ToolContext, "getSandbox">) {
	const modelPhaseEndedAt = new Date().toISOString();
	const prepared = preparedRun.get();
	const mutationSandbox = await ctx.getSandbox();
	const experimentText = requiredText(
		await mutationSandbox.readTextFile({
			path: "/workspace/.wind-tunnel-experiment.json",
		}),
		"Prepared experiment",
	);
	const experiment = parseExperiment(experimentText);
	const archiveLookup = await mutationSandbox.run({
		command:
			"find /workspace/attachments -type f -name 'source.tar.gz' -print -quit",
	});
	if (archiveLookup.exitCode !== 0 || !archiveLookup.stdout.trim())
		throw new Error("Exact source archive is unavailable for verification");
	const sourceArchive = await mutationSandbox.readBinaryFile({
		path: archiveLookup.stdout.trim(),
	});
	if (sourceArchive === null)
		throw new Error("Exact source archive could not be read for verification");

	const staged = await mutationSandbox.run({
		command: `cd ${REPOSITORY_ROOT} && git add -A && git diff --cached --binary --no-ext-diff`,
	});
	if (staged.exitCode !== 0)
		throw new Error(
			`Candidate capture failed: ${bounded(staged.stderr || staged.stdout, 20_000)}`,
		);
	const zeroContextDiff = await mutationSandbox.run({
		command: `cd ${REPOSITORY_ROOT} && git diff --cached --unified=0 --no-ext-diff`,
	});
	if (zeroContextDiff.exitCode !== 0)
		throw new Error("Candidate hunk inspection failed");
	const names = await mutationSandbox.run({
		command: `cd ${REPOSITORY_ROOT} && git diff --cached --name-only`,
	});
	if (names.exitCode !== 0)
		throw new Error(
			`Changed-file capture failed: ${bounded(names.stderr || names.stdout, 20_000)}`,
		);
	const changedFiles = names.stdout
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean);
	const rawDiff = await mutationSandbox.run({
		command: `cd ${REPOSITORY_ROOT} && git diff --cached --raw`,
	});
	if (rawDiff.exitCode !== 0)
		throw new Error("Candidate mode inspection failed");
	if (/(?:^| )120000(?: |$)/m.test(rawDiff.stdout))
		throw new Error("Candidate patch may not create or modify symbolic links");

	const forbidden = changedFiles.filter(protectedPath);
	if (forbidden.length)
		throw new Error(
			`Candidate patch modifies protected or generated paths: ${forbidden.join(", ")}`,
		);

	const experimentAllowedPaths = experiment.allowedPaths ?? [];
	if (experimentAllowedPaths.length) {
		const outsideAllowedPaths = changedFiles.filter(
			(file) => !insideAnyPath(file, experimentAllowedPaths),
		);
		if (outsideAllowedPaths.length)
			throw new Error(
				`Candidate patch modifies paths outside experiment allowedPaths: ${outsideAllowedPaths.join(", ")}`,
			);
	}

	const compiledMutationPaths = prepared?.mutationPaths ?? [];
	if (compiledMutationPaths.length) {
		const outsideMutationSet = changedFiles.filter(
			(file) => !insideAnyPath(file, compiledMutationPaths),
		);
		if (outsideMutationSet.length)
			throw new Error(
				`Candidate patch escapes compiled mutation set: ${outsideMutationSet.join(", ")}. Allowed: ${compiledMutationPaths.join(", ")}`,
			);
	}

	const mutationRanges = prepared?.mutationRanges ?? [];
	const escapedHunks = escapingSymbolHunks(
		zeroContextDiff.stdout,
		mutationRanges,
	);
	if (escapedHunks.length)
		throw new Error(
			`Candidate patch escapes compiled symbol boundaries: ${escapedHunks
				.map(
					(hunk) =>
						`${hunk.file} @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount}`,
				)
				.join("; ")}`,
		);

	await mutationSandbox.delete();

	const verificationSandboxAcquireStartedMs = Date.now();
	const verificationSandbox = await ctx.getSandbox();
	const verificationSandboxAcquireMs =
		Date.now() - verificationSandboxAcquireStartedMs;
	await verificationSandbox.setNetworkPolicy({ allow: ["registry.npmjs.org"] });
	await verificationSandbox.writeBinaryFile({
		path: "/workspace/source.tar.gz",
		content: sourceArchive,
	});
	await verificationSandbox.writeTextFile({
		path: "/workspace/candidate.patch",
		content: staged.stdout,
	});

	const evaluator = resolveEvaluator(experiment.evaluator);
	await verificationSandbox.run({ command: "mkdir -p /workspace/evaluators" });
	for (const [name, content] of Object.entries(evaluator.files))
		await verificationSandbox.writeTextFile({
			path: `/workspace/evaluators/${name}`,
			content,
		});

	const verificationSourceSetupStartedMs = Date.now();
	const sourceSetup = await verificationSandbox.run({
		command: [
			"set -euo pipefail",
			`rm -rf ${REPOSITORY_ROOT}`,
			`mkdir -p ${REPOSITORY_ROOT}`,
			`tar -xzf /workspace/source.tar.gz -C ${REPOSITORY_ROOT}`,
			`cd ${REPOSITORY_ROOT}`,
			"test ! -s /workspace/candidate.patch || git apply --binary --whitespace=nowarn /workspace/candidate.patch",
			"test -f pnpm-lock.yaml",
		].join("\n"),
	});
	const verificationSourceSetupMs =
		Date.now() - verificationSourceSetupStartedMs;
	if (sourceSetup.exitCode !== 0)
		throw new Error(
			`Fresh verification source setup failed with exit ${sourceSetup.exitCode}: ${bounded(sourceSetup.stderr || sourceSetup.stdout, 20_000)}`,
		);

	const verificationDependencyInstallStartedMs = Date.now();
	const dependencyInstall = await verificationSandbox.run({
		command: `cd ${REPOSITORY_ROOT} && pnpm install --frozen-lockfile --prefer-offline --store-dir /workspace/.pnpm-store`,
	});
	const verificationDependencyInstallMs =
		Date.now() - verificationDependencyInstallStartedMs;
	if (dependencyInstall.exitCode !== 0)
		throw new Error(
			`Fresh verification dependency install failed with exit ${dependencyInstall.exitCode}: ${bounded(dependencyInstall.stderr || dependencyInstall.stdout, 20_000)}`,
		);
	await verificationSandbox.setNetworkPolicy("deny-all");

	const checks = await runVerificationPlan(evaluator.checks, ctx);
	const passed = checks
		.filter((check) => check.required)
		.every((check) => check.passed);
	await verificationSandbox.stop();

	const verificationTierDurationsMs = checks.reduce<Record<string, number>>(
		(totals, check) => {
			const tier = check.tier ?? "behavioral";
			totals[tier] = (totals[tier] ?? 0) + check.durationMs;
			return totals;
		},
		{},
	);

	return {
		passed,
		changedFiles,
		checks,
		patch: bounded(staged.stdout),
		patchSha256: createHash("sha256").update(staged.stdout).digest("hex"),
		preparedDependencyKey: prepared?.preparedDependencyKey ?? null,
		mutationBoundary: {
			compiled: compiledMutationPaths.length > 0,
			allowedPaths: compiledMutationPaths,
			allowedSymbols: mutationRanges,
			changedFiles,
			passed: true,
		},
		timings: prepared
			? {
					preparationStartedAt: prepared.preparationStartedAt,
					preparationDurationMs: prepared.preparationDurationMs,
					preparation: prepared.preparationTimings,
					modelPhaseStartedAt: prepared.preparedAt,
					modelPhaseEndedAt,
					modelPhaseDurationMs:
						Date.parse(modelPhaseEndedAt) - Date.parse(prepared.preparedAt),
					modelPhaseBudgetMs: prepared.modelTimeoutMs,
					verification: {
						sandboxAcquireMs: verificationSandboxAcquireMs,
						sourceSetupMs: verificationSourceSetupMs,
						dependencyInstallMs: verificationDependencyInstallMs,
						tiersMs: verificationTierDurationsMs,
					},
				}
			: null,
		verificationIsolation: "fresh-sandbox",
	};
}

export default defineTool({
	description:
		"Capture the candidate patch, enforce compiled file and symbol mutation boundaries, rebuild it in a fresh sandbox, and run trusted progressive verification. Call exactly once after implementation.",
	inputSchema: z.object({}),
	label: { start: () => "Verify candidate in fresh sandbox" },
	execute: (_input, ctx) => finalizeCandidate(ctx),
});
