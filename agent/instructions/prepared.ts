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
					`Hard execution budget: ${prepared.modelTimeoutMs}ms and at most ${prepared.maxToolCalls} exploratory/editing tool calls before finish_run. The bootstrap context is the primary source of truth; do not rediscover information already present there.`,
					"Implement the smallest valid change immediately. Prefer direct edits over repository exploration. Call finish_run exactly once when the patch is ready.",
				].join("\n\n"),
			});
		},
	},
});
