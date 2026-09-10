import { defineTool } from "eve/tools";
import writeFile from "eve/tools/write_file";
import { requireModelBudget } from "../lib/run-state";

export default defineTool({
	...writeFile,
	execute(input, ctx) {
		requireModelBudget();
		return writeFile.execute(input, ctx);
	},
});
