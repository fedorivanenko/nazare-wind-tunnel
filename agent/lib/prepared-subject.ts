import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { REPOSITORY_ROOT, requiredText, safeRepositoryPath, shellQuote } from "./subject";

const SubjectContractSchema = z.object({
  version: z.literal(1),
  runtime: z.object({
    node: z.string().min(1),
    packageManager: z.string().min(1),
  }),
  dependencies: z.object({
    lockfile: z.string().min(1),
    install: z.string().min(1),
  }),
  compile: z.object({
    entrypoint: z.string().min(1),
    output: z.string().min(1),
  }),
});

export type SubjectContract = z.infer<typeof SubjectContractSchema>;

export async function loadSubjectContract(ctx: Pick<ToolContext, "getSandbox">) {
  const sandbox = await ctx.getSandbox();
  const path = safeRepositoryPath(".wind-tunnel/subject.json");
  const text = await sandbox.readTextFile({ path });
  if (text === null) return null;
  return SubjectContractSchema.parse(JSON.parse(requiredText(text, "Subject contract")));
}

export async function dependencyKey(contract: SubjectContract, ctx: Pick<ToolContext, "getSandbox">) {
  const sandbox = await ctx.getSandbox();
  const lockfilePath = safeRepositoryPath(contract.dependencies.lockfile);
  const lockfile = requiredText(await sandbox.readTextFile({ path: lockfilePath }), "Subject lockfile");
  return createHash("sha256")
    .update(JSON.stringify({
      node: contract.runtime.node,
      packageManager: contract.runtime.packageManager,
      lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
    }))
    .digest("hex");
}

export async function compileSubject(contract: SubjectContract, ctx: Pick<ToolContext, "getSandbox">) {
  const sandbox = await ctx.getSandbox();
  const command = `cd ${REPOSITORY_ROOT} && pnpm exec tsx ${shellQuote(safeRepositoryPath(contract.compile.entrypoint))}`;
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) throw new Error(`Subject compiler failed: ${result.stderr || result.stdout}`);
  return {
    outputPath: contract.compile.output,
    stdout: result.stdout,
  };
}
