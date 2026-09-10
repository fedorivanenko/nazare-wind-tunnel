import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { resolveEvaluator } from "./evaluators";
import {
	compileSubject,
	dependencyKey,
	loadSubjectContract,
} from "./prepared-subject";
import { preparedRun, type MutationRange } from "./run-state";
import {
	bounded,
	parseExperiment,
	parseToolManifest,
	REPOSITORY_ROOT,
	requiredText,
	safeRepositoryPath,
	shellQuote,
} from "./subject";

function mutationContractFromBootstrap(
	bootstrap: Array<{ id: string; output: unknown }>,
) {
	const paths = new Set<string>();
	const ranges: MutationRange[] = [];
	for (const entry of bootstrap) {
		if (!entry.output || typeof entry.output !== "object") continue;
		const mutationSet = (entry.output as { mutationSet?: unknown }).mutationSet;
		if (!mutationSet || typeof mutationSet !== "object") continue;
		const files = (mutationSet as { files?: unknown }).files;
		if (Array.isArray(files)) {
			for (const file of files) {
				if (typeof file !== "string" || !file.trim()) continue;
				paths.add(file.trim().replace(/^\.\//, ""));
			}
		}
		const rawRanges = (mutationSet as { ranges?: unknown }).ranges;
		if (!Array.isArray(rawRanges)) continue;
		for (const raw of rawRanges) {
			if (!raw || typeof raw !== "object") continue;
			const value = raw as Record<string, unknown>;
			if (
				typeof value.file !== "string" ||
				typeof value.symbol !== "string" ||
				typeof value.startLine !== "number" ||
				typeof value.endLine !== "number" ||
				!Number.isInteger(value.startLine) ||
				!Number.isInteger(value.endLine) ||
				value.startLine < 1 ||
				value.endLine < value.startLine
			)
				continue;
			ranges.push({
				file: value.file.trim().replace(/^\.\//, ""),
				symbol: value.symbol,
				startLine: value.startLine,
				endLine: value.endLine,
			});
		}
	}
	return {
		paths: [...paths].sort(),
		ranges: ranges.sort((a, b) =>
			a.file === b.file ? a.startLine - b.startLine : a.file.localeCompare(b.file),
		),
	};
}

export async function prepareSubject(
	experimentPath: string,
	ctx: Pick<ToolContext, "getSandbox">,
) {
	const preparationStartedAt = new Date().toISOString();
	const preparationStartedMs = Date.now();

	const sandboxAcquireStartedMs = Date.now();
	const sandbox = await ctx.getSandbox();
	const sandboxAcquireMs = Date.now() - sandboxAcquireStartedMs;
	const experimentFile = safeRepositoryPath(experimentPath);

	const sourceSetupStartedMs = Date.now();
	const sourceSetup = await sandbox.run({
		command: [
			"set -euo pipefail",
			"archive=$(find /workspace/attachments -type f -name 'source.tar.gz' -print -quit)",
			'test -n "$archive"',
			`rm -rf ${REPOSITORY_ROOT}`,
			`mkdir -p ${REPOSITORY_ROOT}`,
			`tar -xzf "$archive" -C ${REPOSITORY_ROOT}`,
			`cd ${REPOSITORY_ROOT}`,
			"git init -q",
			"git config user.name 'Nazare Wind Tunnel'",
			"git config user.email 'wind-tunnel@localhost'",
			"git add -A",
			"git commit -q -m 'Exact source baseline'",
			"test -f pnpm-lock.yaml",
		].join("\n"),
	});
	const sourceSetupMs = Date.now() - sourceSetupStartedMs;
	if (sourceSetup.exitCode !== 0)
		throw new Error(
			`Subject source setup failed with exit ${sourceSetup.exitCode}: ${bounded(sourceSetup.stderr || sourceSetup.stdout || "no command output", 20_000)}`,
		);

	const dependencyInstallStartedMs = Date.now();
	const dependencyInstall = await sandbox.run({
		command: `cd ${REPOSITORY_ROOT} && pnpm install --frozen-lockfile --prefer-offline --store-dir /workspace/.pnpm-store`,
	});
	const dependencyInstallMs = Date.now() - dependencyInstallStartedMs;
	if (dependencyInstall.exitCode !== 0)
		throw new Error(
			`Subject dependency install failed with exit ${dependencyInstall.exitCode}: ${bounded(dependencyInstall.stderr || dependencyInstall.stdout || "no command output", 20_000)}`,
		);

	const subjectCompileStartedMs = Date.now();
	const subjectContract = await loadSubjectContract(ctx);
	const preparedDependencyKey = subjectContract
		? await dependencyKey(subjectContract, ctx)
		: null;
	const compiledSubject = subjectContract
		? await compileSubject(subjectContract, ctx)
		: null;
	const subjectCompileMs = Date.now() - subjectCompileStartedMs;

	await sandbox.setNetworkPolicy("deny-all");

	const experimentText = requiredText(
		await sandbox.readTextFile({ path: experimentFile }),
		"Experiment",
	);
	await sandbox.writeTextFile({
		path: "/workspace/.wind-tunnel-experiment.json",
		content: experimentText,
	});
	const experiment = parseExperiment(experimentText);
	resolveEvaluator(experiment.evaluator);
	const task = requiredText(
		await sandbox.readTextFile({
			path: safeRepositoryPath(experiment.taskFile),
		}),
		"Task",
	);
	const toolManifestText = experiment.tools?.manifest
		? requiredText(
				await sandbox.readTextFile({
					path: safeRepositoryPath(experiment.tools.manifest),
				}),
				"Tool manifest",
			)
		: null;
	const declaredTools = toolManifestText
		? parseToolManifest(toolManifestText)
		: [];
	const allowedTools = new Set(experiment.tools?.allow ?? []);
	const tools = declaredTools.filter((tool) => allowedTools.has(tool.name));
	const bootstrap = [] as Array<{ id: string; output: unknown }>;
	const bootstrapStartedMs = Date.now();
	for (const entry of experiment.tools?.bootstrap ?? []) {
		const inputPath = `/workspace/.wind-tunnel-bootstrap-${bootstrap.length}.json`;
		await sandbox.writeTextFile({
			path: inputPath,
			content: JSON.stringify({ task, experimentPath }),
		});
		const command = `cd ${REPOSITORY_ROOT} && pnpm exec tsx ${shellQuote(safeRepositoryPath(entry.entrypoint))} < ${shellQuote(inputPath)}`;
		const result = await sandbox.run({ command });
		if (result.exitCode !== 0) {
			if (entry.required !== false)
				throw new Error(
					`Required bootstrap ${entry.id} failed: ${bounded(result.stderr || result.stdout, 20_000)}`,
				);
			continue;
		}
		const output = bounded(result.stdout, entry.maxOutputBytes ?? 24_000);
		try {
			bootstrap.push({ id: entry.id, output: JSON.parse(output) });
		} catch {
			bootstrap.push({ id: entry.id, output });
		}
	}
	const bootstrapMs = Date.now() - bootstrapStartedMs;
	const mutationContract = mutationContractFromBootstrap(bootstrap);
	const preparedAt = new Date().toISOString();
	const preparationTimings = {
		sandboxAcquireMs,
		sourceSetupMs,
		dependencyInstallMs,
		subjectCompileMs,
		bootstrapMs,
	};
	const prepared = {
		experimentPath,
		task: bounded(task, 40_000),
		bootstrap,
		tools,
		toolManifestSha256: toolManifestText
			? createHash("sha256").update(toolManifestText).digest("hex")
			: null,
		preparedDependencyKey,
		compiledSubject,
		mutationPaths: mutationContract.paths,
		mutationRanges: mutationContract.ranges,
		modelTimeoutMs: experiment.agent?.timeoutMs ?? 30_000,
		preparationStartedAt,
		preparationDurationMs: Date.now() - preparationStartedMs,
		preparationTimings,
		preparedAt,
	};
	preparedRun.update(() => prepared);
	return { repositoryRoot: REPOSITORY_ROOT, ...prepared };
}
