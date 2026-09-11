import { defineTool } from "eve/tools";
import grep from "eve/tools/grep";
import { requireModelBudget } from "../lib/run-state";

export default defineTool({
	...grep,
	execute(input, ctx) {
		requireModelBudget();
		return grep.execute(input, ctx);
	},
});
