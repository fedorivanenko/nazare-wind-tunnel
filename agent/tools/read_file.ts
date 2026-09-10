import { defineTool } from "eve/tools";
import readFile from "eve/tools/read_file";
import { requireModelBudget } from "../lib/run-state";

export default defineTool({
	...readFile,
	execute(input, ctx) {
		requireModelBudget();
		return readFile.execute(input, ctx);
	},
});
