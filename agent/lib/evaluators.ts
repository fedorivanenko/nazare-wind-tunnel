export type EvaluatorCheck = {
	name: string;
	command: string;
	timeoutMs: number;
	required: boolean;
};

const evaluators: Record<string, EvaluatorCheck[]> = {
	"noop-v1": [
		{
			name: "noop",
			command: 'node -e "process.exit(0)"',
			timeoutMs: 5_000,
			required: true,
		},
	],
	"marketing-consent-v2": [
		{
			name: "task-oracle",
			command: "pnpm exec tsx /workspace/evaluators/marketing-consent-v2.ts",
			timeoutMs: 30_000,
			required: true,
		},
		{ name: "lint", command: "pnpm lint", timeoutMs: 120_000, required: true },
		{ name: "test", command: "pnpm test", timeoutMs: 120_000, required: true },
		{
			name: "typecheck",
			command: "pnpm typecheck",
			timeoutMs: 120_000,
			required: true,
		},
		{
			name: "build",
			command: "pnpm build",
			timeoutMs: 180_000,
			required: true,
		},
	],
};

export function resolveEvaluator(id: string | undefined) {
	if (!id || !evaluators[id])
		throw new Error(`Unknown or missing evaluator: ${id ?? "none"}`);
	return evaluators[id];
}
