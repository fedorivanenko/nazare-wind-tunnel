import type { ToolContext } from "eve/tools";
import { preparedRun } from "./run-state";
import { bounded, REPOSITORY_ROOT, shellQuote } from "./subject";
import { parseRunTask, type RunTask } from "./task";

export async function prepareRun(
	input: {
		repository: string;
		sourceSha: string;
		task: RunTask | unknown;
	},
	ctx: Pick<ToolContext, "getSandbox">,
) {
	const startedAt = new Date().toISOString();
	const startedMs = Date.now();
	const task = parseRunTask(input.task);

	const sandboxAcquireStartedMs = Date.now();
	const sandbox = await ctx.getSandbox();
	const sandboxAcquireMs = Date.now() - sandboxAcquireStartedMs;
	await sandbox.setNetworkPolicy({
		allow: ["github.com", "api.github.com", "objects.githubusercontent.com", "registry.npmjs.org"],
	});

	const sourceSetupStartedMs = Date.now();
	const repositoryUrl = `https://github.com/${input.repository}.git`;
	const sourceSetup = await sandbox.run({
		command: [
			"set -euo pipefail",
			`if [ ! -d ${REPOSITORY_ROOT}/.git ]; then`,
			`  rm -rf ${REPOSITORY_ROOT}`,
			`  git clone --filter=blob:none --no-checkout ${shellQuote(repositoryUrl)} ${REPOSITORY_ROOT}`,
			"fi",
			`cd ${REPOSITORY_ROOT}`,
			`git remote set-url origin ${shellQuote(repositoryUrl)}`,
			`git fetch --quiet --depth=1 origin ${shellQuote(input.sourceSha)}`,
			`git reset --hard ${shellQuote(input.sourceSha)}`,
			"git clean -fdx -e node_modules -e .pnpm-store",
			"git config user.name 'Nazare Wind Tunnel'",
			"git config user.email 'wind-tunnel@localhost'",
		].join("\n"),
	});
	const sourceSetupMs = Date.now() - sourceSetupStartedMs;
	if (sourceSetup.exitCode !== 0)
		throw new Error(
			`Source sync failed with exit ${sourceSetup.exitCode}: ${bounded(sourceSetup.stderr || sourceSetup.stdout || "no command output", 20_000)}`,
		);

	const prepareStartedMs = Date.now();
	for (const command of task.prepare) {
		const result = await sandbox.run({
			command: `cd ${REPOSITORY_ROOT} && timeout 240s bash -lc ${shellQuote(command)}`,
		});
		if (result.exitCode !== 0)
			throw new Error(
				`Prepare command failed (${command}): ${bounded(result.stderr || result.stdout || "no command output", 20_000)}`,
			);
	}
	const prepareMs = Date.now() - prepareStartedMs;

	await sandbox.setNetworkPolicy("deny-all");
	const preparedAt = new Date().toISOString();
	const prepared = {
		repository: input.repository,
		sourceSha: input.sourceSha,
		experimentPath: "inline-task",
		task: task.agent.prompt,
		verifyCommands: task.verify,
		bootstrap: [],
		tools: [],
		toolManifestSha256: null,
		preparedDependencyKey: null,
		compiledSubject: null,
		mutationPaths: [],
		mutationRanges: [],
		modelTimeoutMs: task.agent.timeoutMs ?? 60_000,
		maxToolCalls: task.agent.maxToolCalls ?? 12,
		preparationStartedAt: startedAt,
		preparationDurationMs: Date.now() - startedMs,
		preparationTimings: {
			sandboxAcquireMs,
			sourceSetupMs,
			dependencyInstallMs: prepareMs,
			subjectCompileMs: 0,
			bootstrapMs: 0,
		},
		preparedAt,
	};
	preparedRun.update(() => prepared);
	return { repositoryRoot: REPOSITORY_ROOT, ...prepared };
}
