import { defineTool } from "eve/tools";
import bash from "eve/tools/bash";
import { requireModelBudget } from "../lib/run-state";
import { shellQuote } from "../lib/subject";

export default defineTool({
	...bash,
	execute(input, ctx) {
		const prepared = requireModelBudget();
		const remainingMs = Math.max(
			1,
			Date.parse(prepared.preparedAt) + prepared.modelTimeoutMs - Date.now(),
		);
		return bash.execute(
			{
				command: `cd ${shellQuote(prepared.repositoryRoot)} && CI=1 timeout ${(remainingMs / 1_000).toFixed(3)}s bash -lc ${shellQuote(input.command)}`,
			},
			ctx,
		);
	},
});
