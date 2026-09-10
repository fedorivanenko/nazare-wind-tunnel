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

export type PreparedRun = {
	experimentPath: string;
	task: string;
	bootstrap: Array<{ id: string; output: unknown }>;
	tools: RuntimeTool[];
	toolManifestSha256: string | null;
	preparedDependencyKey: string | null;
	compiledSubject: { outputPath: string; stdout: string } | null;
	modelTimeoutMs: number;
	preparationStartedAt: string;
	preparationDurationMs: number;
	preparedAt: string;
};

export const preparedRun = defineState<PreparedRun | null>(
	"nazare-wind-tunnel.prepared-run-v1",
	() => null,
);

export function requireModelBudget() {
	const prepared = preparedRun.get();
	if (!prepared) throw new Error("Subject preparation is incomplete");
	const deadline = Date.parse(prepared.preparedAt) + prepared.modelTimeoutMs;
	if (Date.now() > deadline)
		throw new Error(
			`Model phase exceeded ${prepared.modelTimeoutMs}ms post-preparation budget`,
		);
	return prepared;
}
