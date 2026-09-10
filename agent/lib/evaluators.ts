import marketingConsentV2Source from "./marketing-consent-v2.source";

export type VerificationTier = "structural" | "focused" | "behavioral" | "full";

export type EvaluatorCheck = {
	name: string;
	command: string;
	timeoutMs: number;
	required: boolean;
	tier?: VerificationTier;
};

export type EvaluatorDefinition = {
	files: Record<string, string>;
	checks: EvaluatorCheck[];
};

const evaluators: Record<string, EvaluatorDefinition> = {
	"noop-v1": {
		files: {},
		checks: [
			{
				name: "noop",
				command: 'node -e "process.exit(0)"',
				timeoutMs: 5_000,
				required: true,
				tier: "structural",
			},
		],
	},
	"marketing-consent-v2": {
		files: {
			"marketing-consent-v2.ts": Buffer.from(
				marketingConsentV2Source,
				"base64",
			).toString("utf8"),
		},
		checks: [
			{
				name: "lint",
				command: "pnpm lint",
				timeoutMs: 120_000,
				required: true,
				tier: "structural",
			},
			{
				name: "test",
				command: "pnpm test",
				timeoutMs: 120_000,
				required: true,
				tier: "focused",
			},
			{
				name: "task-oracle",
				command: "pnpm exec tsx /workspace/evaluators/marketing-consent-v2.ts",
				timeoutMs: 30_000,
				required: true,
				tier: "behavioral",
			},
			{
				name: "typecheck",
				command: "pnpm typecheck",
				timeoutMs: 120_000,
				required: true,
				tier: "full",
			},
			{
				name: "build",
				command: "pnpm build",
				timeoutMs: 180_000,
				required: true,
				tier: "full",
			},
		],
	},
};

export function resolveEvaluator(id: string | undefined) {
	if (!id || !evaluators[id])
		throw new Error(`Unknown or missing evaluator: ${id ?? "none"}`);
	return evaluators[id];
}
