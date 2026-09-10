import type { ToolContext } from "eve/tools";
import { bounded, REPOSITORY_ROOT, shellQuote } from "./subject";

export type VerificationCheck = {
	name: string;
	command: string;
	required: boolean;
	timeoutMs: number;
	tier?: "structural" | "focused" | "behavioral" | "full";
};

export async function runVerificationPlan(
	checks: VerificationCheck[],
	ctx: Pick<ToolContext, "getSandbox">,
) {
	const sandbox = await ctx.getSandbox();
	const results: Array<
		VerificationCheck & {
			passed: boolean;
			exitCode: number;
			stdout: string;
			stderr: string;
			durationMs: number;
		}
	> = [];
	const tiers = ["structural", "focused", "behavioral", "full"] as const;

	for (const tier of tiers) {
		const tierChecks = checks.filter(
			(check) => (check.tier ?? "behavioral") === tier,
		);
		if (!tierChecks.length) continue;
		const tierResults = await Promise.all(
			tierChecks.map(async (check) => {
				const seconds = Math.max(1, Math.ceil(check.timeoutMs / 1_000));
				const started = Date.now();
				const result = await sandbox.run({
					command: `cd ${REPOSITORY_ROOT} && timeout ${seconds}s bash -lc ${shellQuote(check.command)}`,
				});
				return {
					...check,
					passed: result.exitCode === 0,
					exitCode: result.exitCode,
					stdout: bounded(result.stdout, 20_000),
					stderr: bounded(result.stderr, 20_000),
					durationMs: Date.now() - started,
				};
			}),
		);
		results.push(...tierResults);
		if (tierResults.some((result) => result.required && !result.passed)) break;
	}

	return results;
}
