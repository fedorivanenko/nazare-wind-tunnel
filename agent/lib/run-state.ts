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
	preparedAt: string;
};

export const preparedRun = defineState<PreparedRun | null>(
	"nazare-wind-tunnel.prepared-run-v1",
	() => null,
);
