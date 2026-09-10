import { createHash } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { preparedRun } from "../lib/run-state";
import {
	bounded,
	parseExperiment,
	parseToolManifest,
	REPOSITORY_ROOT,
	requiredText,
	safeRepositoryPath,
	shellQuote,
} from "../lib/subject";

export default defineTool({
	description:
		"Prepare attached exact source snapshot, install dependencies, and return task plus deterministic bootstrap context. Call once before reading or editing source.",
	inputSchema: z.object({ experimentPath: z.string().min(1) }),
	label: { start: ({ experimentPath }) => `Prepare ${experimentPath}` },
	async execute({ experimentPath }, ctx) {
		const sandbox = await ctx.getSandbox();
		const experimentFile = safeRepositoryPath(experimentPath);
		const prepare = await sandbox.run({
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
				"pnpm install --frozen-lockfile --prefer-offline",
			].join("\n"),
		});
		if (prepare.exitCode !== 0)
			throw new Error(
				`Subject preparation failed with exit ${prepare.exitCode}: ${bounded(prepare.stderr || prepare.stdout || "no command output", 20_000)}`,
			);
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
		const prepared = {
			experimentPath,
			task: bounded(task, 40_000),
			bootstrap,
			tools,
			toolManifestSha256: toolManifestText
				? createHash("sha256").update(toolManifestText).digest("hex")
				: null,
			preparedAt: new Date().toISOString(),
		};
		preparedRun.update(() => prepared);
		return { repositoryRoot: REPOSITORY_ROOT, ...prepared };
	},
});
