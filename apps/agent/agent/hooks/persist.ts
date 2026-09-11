import { defineHook } from "eve/hooks";
import { finishRun, persistEvent } from "../lib/database";

export default defineHook({
	events: {
		async "*"(event, ctx) {
			if (!process.env.DATABASE_URL || !ctx || !event.meta.id) return;
			const runId =
				typeof ctx.session.auth.current?.attributes.runId === "string"
					? ctx.session.auth.current.attributes.runId
					: undefined;
			await persistEvent({
				id: event.meta.id,
				runId,
				sessionId: ctx.session.id,
				type: event.type,
				data: "data" in event ? event.data : null,
				at: event.meta.at,
			}).catch((error) => console.error("Could not persist eve event", error));
			if (!runId || event.type !== "action.result") return;
			const result = event.data.result;
			if (
				result.kind === "tool-result" &&
				result.toolName === "finish_run" &&
				!result.isError &&
				typeof result.output === "object" &&
				result.output !== null &&
				"passed" in result.output &&
				result.output.passed === true
			)
				await finishRun(runId, result.output).catch((error) =>
					console.error("Could not finalize run", error),
				);
		},
	},
});
