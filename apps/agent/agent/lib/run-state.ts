import { defineState } from "eve/context";

export type PreparationTimings = {
	sandboxAcquireMs: number;
	sourceSetupMs: number;
	dependencyInstallMs: number;
};

export type PreparedRun = {
	sourceSha: string;
	repositoryRoot: string;
	verifyCommands: string[];
	modelTimeoutMs: number;
	maxToolCalls: number;
	preparationStartedAt: string;
	preparationDurationMs: number;
	preparationTimings: PreparationTimings;
	preparedAt: string;
};

export const preparedRun = defineState<PreparedRun | null>(
	"nazare-wind-tunnel.prepared-run-v4",
	() => null,
);

const modelToolCalls = defineState<number>(
	"nazare-wind-tunnel.model-tool-calls-v4",
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
