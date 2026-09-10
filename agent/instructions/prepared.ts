import { defineDynamic, defineInstructions } from "eve/instructions";
import { preparedRun } from "../lib/run-state";

export default defineDynamic({
	events: {
		"session.started": async () => {
			const prepared = preparedRun.get();
			if (!prepared) return null;
			const mutationBoundary = prepared.mutationPaths.length
				? `Compiled mutation boundary (hard-enforced):\n${prepared.mutationPaths.join("\n")}`
				: "Compiled mutation boundary: none declared; repository safety rules still apply.";
			return defineInstructions({
				role: "user",
				content: [
					`Task:\n${prepared.task}`,
					"Repository root: /workspace/repo",
					mutationBoundary,
					`Bootstrap context:\n${JSON.stringify(prepared.bootstrap)}`,
					`Model phase began at ${prepared.preparedAt} and has ${prepared.modelTimeoutMs}ms. Implement immediately, stay inside the compiled mutation boundary, then call finish_run exactly once.`,
				].join("\n\n"),
			});
		},
	},
});
