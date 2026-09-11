import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { preparedRun, resetModelBudget } from "./run-state";
import { bounded, REPOSITORY_ROOT, shellQuote } from "./subject";
import { parseRunTask, type RunTask } from "./task";

const SOURCE_MIRROR = "/workspace/source.git";
const PREPARATION_KEY_PATH = "/workspace/.wind-tunnel-preparation-key";

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
	const repositoryRoot = REPOSITORY_ROOT;
	const preparationKey = createHash("sha256")
		.update(
			JSON.stringify({
				repository: input.repository,
				sourceSha: input.sourceSha,
				prepare: task.prepare,
			}),
		)
		.digest("hex");

	const sandboxAcquireStartedMs = Date.now();
	const sandbox = await ctx.getSandbox();
	const sandboxAcquireMs = Date.now() - sandboxAcquireStartedMs;
	await sandbox.setNetworkPolicy({
		allow: [
			"github.com",
			"api.github.com",
			"objects.githubusercontent.com",
			"registry.npmjs.org",
		],
	});

	const sourceSetupStartedMs = Date.now();
	const repositoryUrl = `https://github.com/${input.repository}.git`;
	const sourceSetup = await sandbox.run({
		command: [
			"set -euo pipefail",
			`if [ ! -d ${SOURCE_MIRROR} ]; then`,
			`  git clone --mirror --filter=blob:none ${shellQuote(repositoryUrl)} ${SOURCE_MIRROR}`,
			"fi",
			`git --git-dir=${SOURCE_MIRROR} remote set-url origin ${shellQuote(repositoryUrl)}`,
			`git --git-dir=${SOURCE_MIRROR} fetch --quiet origin ${shellQuote(input.sourceSha)}`,
			`git --git-dir=${SOURCE_MIRROR} worktree prune`,
			`if [ ! -e ${shellQuote(`${repositoryRoot}/.git`)} ]; then`,
			`  rm -rf ${shellQuote(repositoryRoot)}`,
			`  git --git-dir=${SOURCE_MIRROR} worktree add --detach ${shellQuote(repositoryRoot)} ${shellQuote(input.sourceSha)}`,
			"else",
			`  git -C ${shellQuote(repositoryRoot)} reset --hard ${shellQuote(input.sourceSha)}`,
			`  git -C ${shellQuote(repositoryRoot)} clean -fd`,
			"fi",
			`cd ${shellQuote(repositoryRoot)}`,
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
	const cachedPreparation = await sandbox.run({
		command: `test "$(cat ${PREPARATION_KEY_PATH} 2>/dev/null || true)" = ${shellQuote(preparationKey)}`,
	});
	if (cachedPreparation.exitCode !== 0) {
		for (const command of task.prepare) {
			const result = await sandbox.run({
				command: `cd ${shellQuote(repositoryRoot)} && CI=1 timeout 240s bash -lc ${shellQuote(command)}`,
			});
			if (result.exitCode !== 0)
				throw new Error(
					`Prepare command failed (${command}): ${bounded(result.stderr || result.stdout || "no command output", 20_000)}`,
				);
		}
		await sandbox.writeTextFile({
			path: PREPARATION_KEY_PATH,
			content: preparationKey,
		});
	}
	const prepareMs = Date.now() - prepareStartedMs;

	await sandbox.setNetworkPolicy("deny-all");
	const preparedAt = new Date().toISOString();
	const prepared = {
		sourceSha: input.sourceSha,
		repositoryRoot,
		verifyCommands: task.verify,
		modelTimeoutMs: task.agent.timeoutMs ?? 60_000,
		maxToolCalls: task.agent.maxToolCalls ?? 12,
		preparationStartedAt: startedAt,
		preparationDurationMs: Date.now() - startedMs,
		preparationTimings: {
			sandboxAcquireMs,
			sourceSetupMs,
			dependencyInstallMs: prepareMs,
		},
		preparedAt,
	};
	preparedRun.update(() => prepared);
	resetModelBudget();
	return prepared;
}
