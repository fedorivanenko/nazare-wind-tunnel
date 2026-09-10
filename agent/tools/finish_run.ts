import { createHash } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { resolveEvaluator } from "../lib/evaluators";
import {
	bounded,
	parseExperiment,
	REPOSITORY_ROOT,
	requiredText,
	shellQuote,
} from "../lib/subject";

const PROTECTED_PATHS = [".git", ".wind-tunnel", "experiments", ".github"];

function protectedPath(relativePath: string) {
	return PROTECTED_PATHS.some(
		(prefix) =>
			relativePath === prefix || relativePath.startsWith(`${prefix}/`),
	);
}

export default defineTool({
	description:
		"Capture the candidate patch, rebuild it in a fresh sandbox, and run trusted experiment verification. Call exactly once after implementation.",
	inputSchema: z.object({}),
	label: { start: () => "Verify candidate in fresh sandbox" },
	async execute(_input, ctx) {
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
			throw new Error(
				"Exact source archive could not be read for verification",
			);
		const staged = await mutationSandbox.run({
			command: `cd ${REPOSITORY_ROOT} && git add -A -- . ':(exclude)node_modules' ':(exclude)**/node_modules/**' && git diff --cached --binary --no-ext-diff`,
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
		const forbidden = changedFiles.filter(protectedPath);
		if (forbidden.length)
			throw new Error(
				`Candidate patch modifies protected harness paths: ${forbidden.join(", ")}`,
			);

		await mutationSandbox.delete();
		const verificationSandbox = await ctx.getSandbox();
		await verificationSandbox.setNetworkPolicy({
			allow: ["registry.npmjs.org"],
		});
		await verificationSandbox.writeBinaryFile({
			path: "/workspace/source.tar.gz",
			content: sourceArchive,
		});
		await verificationSandbox.writeTextFile({
			path: "/workspace/candidate.patch",
			content: staged.stdout,
		});
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
		if (setup.exitCode !== 0)
			throw new Error(
				`Fresh verification setup failed with exit ${setup.exitCode}: ${bounded(setup.stderr || setup.stdout, 20_000)}`,
			);
		await verificationSandbox.setNetworkPolicy("deny-all");

		const checks = [] as Array<{
			name: string;
			command: string;
			required: boolean;
			passed: boolean;
			exitCode: number;
			stdout: string;
			stderr: string;
		}>;
		for (const check of resolveEvaluator(experiment.evaluator)) {
			const seconds = Math.max(1, Math.ceil(check.timeoutMs / 1_000));
			const result = await verificationSandbox.run({
				command: `cd ${REPOSITORY_ROOT} && timeout ${seconds}s bash -lc ${shellQuote(check.command)}`,
			});
			checks.push({
				name: check.name,
				command: check.command,
				required: check.required,
				passed: result.exitCode === 0,
				exitCode: result.exitCode,
				stdout: bounded(result.stdout, 20_000),
				stderr: bounded(result.stderr, 20_000),
			});
		}
		const passed = checks
			.filter((check) => check.required)
			.every((check) => check.passed);
		await verificationSandbox.stop();
		return {
			passed,
			changedFiles,
			checks,
			patch: bounded(staged.stdout),
			patchSha256: createHash("sha256").update(staged.stdout).digest("hex"),
			verificationIsolation: "fresh-sandbox",
		};
	},
});
