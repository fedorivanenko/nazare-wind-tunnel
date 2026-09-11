import { defineState } from "eve/context";

export type RuntimeToolField = {
	type: "string" | "boolean" | "number";
	description?: string;
	optional?: boolean;
};

export type RuntimeTool = {
	name: string;
	description: string;
	entrypoint: string;
	operation: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	parameters: Record<string, RuntimeToolField>;
};

export type PreparationTimings = {
	sandboxAcquireMs: number;
	sourceSetupMs: number;
	dependencyInstallMs: number;
	subjectCompileMs: number;
	bootstrapMs: number;
};

export type MutationRange = {
	file: string;
	symbol: string;
	startLine: number;
	endLine: number;
};

export type PreparedRun = {
	runId: string;
	repository: string;
	sourceSha: string;
	repositoryRoot: string;
	experimentPath: string;
	task: string;
	verifyCommands: string[];
	bootstrap: Array<{ id: string; output: unknown }>;
	tools: RuntimeTool[];
	toolManifestSha256: string | null;
	preparedDependencyKey: string | null;
	compiledSubject: {
		outputPath: string;
		sha256: string;
		bytes: number;
		stdout: string;
	} | null;
	mutationPaths: string[];
	mutationRanges: MutationRange[];
	modelTimeoutMs: number;
	maxToolCalls: number;
	preparationStartedAt: string;
	preparationDurationMs: number;
	preparationTimings: PreparationTimings;
	preparedAt: string;
};

export const preparedRun = defineState<PreparedRun | null>(
	"nazare-wind-tunnel.prepared-run-v3",
	() => null,
);

const modelToolCalls = defineState<number>(
	"nazare-wind-tunnel.model-tool-calls-v3",
	() => 0,
);

export function resetModelBudget() {
	modelToolCalls.update(() => 0);
}

export function requireModelBudget() {
	const prepared = preparedRun.get();
	if (!prepared) throw new Error("Run preparation is incomplete");
	const deadline = Date.parse(prepared.preparedAt) + prepared.modelTimeoutMs;
	if (Date.now() > deadline)
		throw new Error(
			`Model phase exceeded ${prepared.modelTimeoutMs}ms post-preparation budget`,
		);
	const calls = modelToolCalls.get() + 1;
	modelToolCalls.update(() => calls);
	if (calls > prepared.maxToolCalls)
		throw new Error(
			`Model phase exceeded ${prepared.maxToolCalls} tool calls; use prepared context and finish the patch instead of exploring further`,
		);
	return prepared;
}
