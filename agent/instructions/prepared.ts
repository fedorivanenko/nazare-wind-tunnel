import { defineDynamic, defineInstructions } from "eve/instructions";
import { preparedRun } from "../lib/run-state";

export default defineDynamic({
	events: {
		"session.started": async () => {
			const prepared = preparedRun.get();
			if (!prepared) return null;
			return defineInstructions({
				role: "user",
				content: [
					`Task:\n${prepared.task}`,
					"Repository root: /workspace/repo",
					`Bootstrap context:\n${JSON.stringify(prepared.bootstrap)}`,
					`Model phase began at ${prepared.preparedAt} and has ${prepared.modelTimeoutMs}ms. Implement immediately, then call finish_run exactly once.`,
				].join("\n\n"),
			});
		},
	},
});
