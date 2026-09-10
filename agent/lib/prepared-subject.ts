import { createHash } from "node:crypto";
import path from "node:path";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import {
	REPOSITORY_ROOT,
	requiredText,
	safeRepositoryPath,
	shellQuote,
} from "./subject";

const SubjectContractSchema = z.object({
	version: z.literal(1),
	runtime: z.object({
		node: z.string().min(1),
		packageManager: z.string().min(1),
	}),
	dependencies: z.object({
		lockfile: z.string().min(1),
		install: z.string().min(1).max(500),
	}),
	compile: z.object({
		entrypoint: z.string().min(1),
		output: z.string().min(1),
	}),
});

export type SubjectContract = z.infer<typeof SubjectContractSchema>;

export async function loadSubjectContract(
	ctx: Pick<ToolContext, "getSandbox">,
) {
	const sandbox = await ctx.getSandbox();
	const contractPath = safeRepositoryPath(".wind-tunnel/subject.json");
	const text = await sandbox.readTextFile({ path: contractPath });
	if (text === null) return null;
	return SubjectContractSchema.parse(
		JSON.parse(requiredText(text, "Subject contract")),
	);
}

export async function dependencyKey(
	contract: SubjectContract,
	ctx: Pick<ToolContext, "getSandbox">,
) {
	const sandbox = await ctx.getSandbox();
	const lockfilePath = safeRepositoryPath(contract.dependencies.lockfile);
	const lockfile = requiredText(
		await sandbox.readTextFile({ path: lockfilePath }),
		"Subject lockfile",
	);
	return createHash("sha256")
		.update(
			JSON.stringify({
				node: contract.runtime.node,
				packageManager: contract.runtime.packageManager,
				lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
			}),
		)
		.digest("hex");
}

export function subjectDependencyInstallCommand(
	contract: SubjectContract | null,
) {
	return (
		contract?.dependencies.install ??
		"pnpm install --frozen-lockfile --prefer-offline --store-dir /workspace/.pnpm-store"
	);
}

export async function compileSubject(
	contract: SubjectContract,
	ctx: Pick<ToolContext, "getSandbox">,
) {
	const sandbox = await ctx.getSandbox();
	const outputPath = path.posix.normalize(contract.compile.output);
	if (
		!outputPath.startsWith("/workspace/") ||
		outputPath === REPOSITORY_ROOT ||
		outputPath.startsWith(`${REPOSITORY_ROOT}/`)
	)
		throw new Error(
			"Compiled subject output must live under /workspace outside the candidate repository",
		);
	const command = [
		`cd ${REPOSITORY_ROOT}`,
		`WIND_TUNNEL_SUBJECT_OUTPUT=${shellQuote(outputPath)} pnpm exec tsx ${shellQuote(
			safeRepositoryPath(contract.compile.entrypoint),
		)}`,
	].join(" && ");
	const result = await sandbox.run({ command });
	if (result.exitCode !== 0)
		throw new Error(
			`Subject compiler failed: ${result.stderr || result.stdout}`,
		);
	const compiled = requiredText(
		await sandbox.readTextFile({ path: outputPath }),
		"Compiled subject",
	);
	return {
		outputPath,
		sha256: createHash("sha256").update(compiled).digest("hex"),
		bytes: Buffer.byteLength(compiled),
		stdout: result.stdout,
	};
}
