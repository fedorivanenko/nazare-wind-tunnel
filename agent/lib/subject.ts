import path from "node:path";
import type { RuntimeTool } from "./run-state";

export const REPOSITORY_ROOT = "/workspace/repo";
const MAX_TEXT_BYTES = 200_000;

export function safeRepositoryPath(relativePath: string) {
	if (!relativePath || path.isAbsolute(relativePath))
		throw new Error(`Expected repository-relative path: ${relativePath}`);
	const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
	if (
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized === ".git" ||
		normalized.startsWith(".git/") ||
		normalized.includes("/.git/")
	)
		throw new Error(`Path escapes repository: ${relativePath}`);
	return `${REPOSITORY_ROOT}/${normalized}`;
}

export function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function requiredText(value: string | null, label: string) {
	if (value === null) throw new Error(`${label} not found`);
	return value;
}

export function bounded(text: string, maxBytes = MAX_TEXT_BYTES) {
	const bytes = Buffer.from(text);
	return bytes.byteLength <= maxBytes
		? text
		: `${bytes.subarray(0, maxBytes).toString("utf8")}\n[truncated at ${maxBytes} bytes]`;
}

export type ExperimentDefinition = {
	taskFile: string;
	evaluator?: string;
	agent?: { timeoutMs?: number; maxToolCalls?: number };
	allowedPaths?: string[];
	tools?: {
		manifest?: string;
		allow?: string[];
		bootstrap?: Array<{
			id: string;
			entrypoint: string;
			timeoutMs?: number;
			maxOutputBytes?: number;
			required?: boolean;
		}>;
	};
	verification?: Array<
		| string
		| { name?: string; command: string; required?: boolean; timeoutMs?: number }
	>;
};

export function parseExperiment(text: string): ExperimentDefinition {
	const value = JSON.parse(text) as ExperimentDefinition;
	if (typeof value.taskFile !== "string" || !value.taskFile)
		throw new Error("Experiment taskFile missing");
	if (
		value.agent?.maxToolCalls !== undefined &&
		(!Number.isInteger(value.agent.maxToolCalls) ||
			value.agent.maxToolCalls < 1 ||
			value.agent.maxToolCalls > 32)
	)
		throw new Error("Experiment agent.maxToolCalls must be an integer from 1 to 32");
	if (
		value.allowedPaths !== undefined &&
		(!Array.isArray(value.allowedPaths) ||
			value.allowedPaths.some((entry) => typeof entry !== "string" || !entry))
	)
		throw new Error(
			"Experiment allowedPaths must contain repository-relative paths",
		);
	for (const entry of value.allowedPaths ?? []) safeRepositoryPath(entry);
	return value;
}

export function parseToolManifest(text: string): RuntimeTool[] {
	const value = JSON.parse(text) as { version?: unknown; tools?: unknown };
	if (value.version !== 1 || !Array.isArray(value.tools))
		throw new Error("Tool manifest must use version 1 and contain tools");
	return value.tools.map((candidate) => {
		if (!candidate || typeof candidate !== "object")
			throw new Error("Invalid tool manifest entry");
		const tool = candidate as RuntimeTool;
		if (!/^[a-z][a-z0-9_]{1,63}$/.test(tool.name))
			throw new Error(`Invalid runtime tool name: ${tool.name}`);
		if (
			[
				"prepare_subject",
				"finish_run",
				"bash",
				"read_file",
				"write_file",
				"grep",
			].includes(tool.name)
		)
			throw new Error(`Runtime tool name is reserved: ${tool.name}`);
		if (typeof tool.description !== "string" || !tool.description)
			throw new Error(`Runtime tool ${tool.name} needs a description`);
		if (
			!tool.entrypoint.startsWith(".wind-tunnel/tools/") ||
			!tool.entrypoint.endsWith(".ts")
		)
			throw new Error(`Runtime tool ${tool.name} has forbidden entrypoint`);
		if (!/^[a-z][a-z0-9_-]{1,63}$/.test(tool.operation))
			throw new Error(`Runtime tool ${tool.name} has invalid operation`);
		if (!tool.parameters || typeof tool.parameters !== "object")
			throw new Error(`Runtime tool ${tool.name} needs parameters`);
		for (const [name, field] of Object.entries(tool.parameters)) {
			if (
				!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
				!["string", "boolean", "number"].includes(field.type)
			)
				throw new Error(
					`Runtime tool ${tool.name} has invalid parameter ${name}`,
				);
		}
		return tool;
	});
}
