import { defineHook } from "eve/hooks";
import { failRun, finishRun, getRun } from "../lib/database";
import { finalizeCandidate } from "../tools/finish_run";

export default defineHook({
	events: {
		async "session.waiting"(_event, ctx) {
			if (!process.env.DATABASE_URL) return;
			const run = await getRun(ctx.session.id);
			if (!run || run.result !== null) return;
			try {
				const result = await finalizeCandidate(ctx);
				await finishRun(ctx.session.id, result);
			} catch (error) {
				await failRun(ctx.session.id, {
					code: "automatic_finalization_failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		},
	},
});
