import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import {
	preparedRun,
	type RuntimeTool,
	type RuntimeToolField,
	requireModelBudget,
} from "../lib/run-state";
import {
	bounded,
	REPOSITORY_ROOT,
	safeRepositoryPath,
	shellQuote,
} from "../lib/subject";

function fieldSchema(field: RuntimeToolField) {
	let schema: z.ZodType =
		field.type === "boolean"
			? z.boolean()
			: field.type === "number"
				? z.number()
				: z.string();
	if (field.description) schema = schema.describe(field.description);
	return field.optional ? schema.optional() : schema;
}

function inputSchema(tool: RuntimeTool) {
	return z.object(
		Object.fromEntries(
			Object.entries(tool.parameters).map(([name, field]) => [
				name,
				fieldSchema(field),
			]),
		),
	);
}

export default defineDynamic({
	events: {
		"step.started": async () => {
			const prepared = preparedRun.get();
			if (!prepared) return null;
			return Object.fromEntries(
				prepared.tools.map((tool) => [
					tool.name,
					defineTool({
						description: tool.description,
						inputSchema: inputSchema(tool),
						label: { start: () => tool.name },
						async execute(input, ctx) {
							requireModelBudget();
							const sandbox = await ctx.getSandbox();
							const inputPath = `/workspace/.wind-tunnel-tool-${crypto.randomUUID()}.json`;
							await sandbox.writeTextFile({
								path: inputPath,
								content: JSON.stringify(input),
							});
							const seconds = Math.max(
								1,
								Math.ceil((tool.timeoutMs ?? 3_000) / 1_000),
							);
							const result = await sandbox.run({
								command: `cd ${REPOSITORY_ROOT} && timeout ${seconds}s pnpm exec tsx ${shellQuote(safeRepositoryPath(tool.entrypoint))} --wind-tunnel-tool ${shellQuote(tool.operation)} < ${shellQuote(inputPath)}`,
							});
							await sandbox.removePath({ path: inputPath, force: true });
							if (result.exitCode !== 0)
								throw new Error(
									`Target tool ${tool.name} failed with exit ${result.exitCode}: ${bounded(result.stderr || result.stdout, 10_000)}`,
								);
							const output = bounded(
								result.stdout,
								tool.maxOutputBytes ?? 24_000,
							);
							try {
								return JSON.parse(output) as unknown;
							} catch {
								return { content: output };
							}
						},
					}),
				]),
			);
		},
	},
});
