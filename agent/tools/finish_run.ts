import { createHash } from "node:crypto";
import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { resolveEvaluator } from "../lib/evaluators";
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
		command: "find /workspace/attachments -type f -name 'source.tar.gz' -print -quit",
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
	if (rawDiff.exitCode !== 0) throw new Error("Candidate mode inspection failed");
	if (/(?:^| )120000(?: |$)/m.test(rawDiff.stdout))
		throw new Error("Candidate patch may not create or modify symbolic links");

	const forbidden = changedFiles.filter(protectedPath);
	if (forbidden.length)
		throw new Error(
			`Candidate patch modifies protected or generated paths: ${forbidden.join(", ")}`,
		);
	if (experiment.allowedPaths?.length) {
		const outsideAllowedPaths = changedFiles.filter(
			(file) =>
				!experiment.allowedPaths?.some(
					(prefix) => file === prefix || file.startsWith(`${prefix}/`),
				),
		);
		if (outsideAllowedPaths.length)
			throw new Error(
				`Candidate patch modifies paths outside allowedPaths: ${outsideAllowedPaths.join(", ")}`,
			);
	}

	await mutationSandbox.delete();
	const verificationSandbox = await ctx.getSandbox();
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

	const verificationSetupStartedMs = Date.now();
	const setup = await verificationSandbox.run({
		command: [
			"set -euo pipefail",
			`rm -rf ${REPOSITORY_ROOT}`,
			`mkdir -p ${REPOSITORY_ROOT}`,
			`tar -xzf /workspace/source.tar.gz -C ${REPOSITORY_ROOT}`,
			`cd ${REPOSITORY_ROOT}`,
			"test ! -s /workspace/candidate.patch || git apply --binary --whitespace=nowarn /workspace/candidate.patch",
			"test -f pnpm-lock.yaml",
			"pnpm install --frozen-lockfile --prefer-offline",
		].join("\n"),
	});
	const verificationSetupDurationMs = Date.now() - verificationSetupStartedMs;
	if (setup.exitCode !== 0)
		throw new Error(
			`Fresh verification setup failed with exit ${setup.exitCode}: ${bounded(setup.stderr || setup.stdout, 20_000)}`,
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
		timings: prepared
			? {
					preparationStartedAt: prepared.preparationStartedAt,
					preparationDurationMs: prepared.preparationDurationMs,
					modelPhaseStartedAt: prepared.preparedAt,
					modelPhaseEndedAt,
					modelPhaseDurationMs:
						Date.parse(modelPhaseEndedAt) - Date.parse(prepared.preparedAt),
					modelPhaseBudgetMs: prepared.modelTimeoutMs,
					verificationSetupDurationMs,
					verificationTierDurationsMs,
				}
			: null,
		verificationIsolation: "fresh-sandbox",
	};
}

export default defineTool({
	description:
		"Capture the candidate patch, rebuild it in a fresh sandbox, and run trusted progressive verification. Call exactly once after implementation.",
	inputSchema: z.object({}),
	label: { start: () => "Verify candidate in fresh sandbox" },
	execute: (_input, ctx) => finalizeCandidate(ctx),
});
