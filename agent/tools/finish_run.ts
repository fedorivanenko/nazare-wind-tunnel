import { defineTool } from "eve/tools";
import { z } from "zod";
import {
	bounded,
	parseExperiment,
	REPOSITORY_ROOT,
	requiredText,
} from "../lib/subject";

export default defineTool({
	description:
		"Run trusted experiment verification and capture candidate Git patch. Call exactly once after implementation.",
	inputSchema: z.object({}),
	label: { start: () => "Verify and capture candidate" },
	async execute(_input, ctx) {
		const sandbox = await ctx.getSandbox();
		const experiment = parseExperiment(
			requiredText(
				await sandbox.readTextFile({
					path: "/workspace/.wind-tunnel-experiment.json",
				}),
				"Prepared experiment",
			),
		);
		const checks = [] as Array<{
			name: string;
			command: string;
			required: boolean;
			passed: boolean;
			exitCode: number;
			stdout: string;
			stderr: string;
		}>;
		for (const [index, value] of (experiment.verification ?? []).entries()) {
			const check =
				typeof value === "string"
					? { name: `check-${index + 1}`, command: value, required: true }
					: {
							name: value.name ?? `check-${index + 1}`,
							command: value.command,
							required: value.required !== false,
						};
			const result = await sandbox.run({
				command: `cd ${REPOSITORY_ROOT} && ${check.command}`,
			});
			checks.push({
				...check,
				passed: result.exitCode === 0,
				exitCode: result.exitCode,
				stdout: bounded(result.stdout, 20_000),
				stderr: bounded(result.stderr, 20_000),
			});
		}
		const staged = await sandbox.run({
			command: `cd ${REPOSITORY_ROOT} && git add -A && git diff --cached --binary --no-ext-diff`,
		});
		if (staged.exitCode !== 0)
			throw new Error(
				`Candidate capture failed: ${bounded(staged.stderr || staged.stdout, 20_000)}`,
			);
		const names = await sandbox.run({
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
		const passed = checks
			.filter((check) => check.required)
			.every((check) => check.passed);
		await sandbox.writeTextFile({
			path: "/workspace/wind-tunnel-result.json",
			content: JSON.stringify(
				{ passed, changedFiles, checks, patch: staged.stdout },
				null,
				2,
			),
		});
		return { passed, changedFiles, checks, patch: bounded(staged.stdout) };
	},
});
