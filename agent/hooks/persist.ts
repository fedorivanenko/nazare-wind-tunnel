import { defineHook } from "eve/hooks";
import { finishRun, persistEvent } from "../lib/database";

export default defineHook({
	events: {
		async "*"(event, ctx) {
			if (!process.env.DATABASE_URL || !ctx || !event.meta.id) return;
			await persistEvent({
				id: event.meta.id,
				runId:
					typeof ctx.session.auth.initiator?.attributes.runId === "string"
						? ctx.session.auth.initiator.attributes.runId
						: undefined,
				sessionId: ctx.session.id,
				type: event.type,
				data: "data" in event ? event.data : null,
				at: event.meta.at,
			}).catch((error) => console.error("Could not persist eve event", error));
			if (event.type !== "action.result") return;
			const result = event.data.result;
			if (
				result.kind === "tool-result" &&
				result.toolName === "finish_run" &&
				!result.isError
			)
				await finishRun(ctx.session.id, result.output).catch((error) =>
					console.error("Could not finalize run", error),
				);
		},
	},
});
