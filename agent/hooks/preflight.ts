import { defineHook } from "eve/hooks";
import { prepareSubject } from "../lib/prepare";

export default defineHook({
	events: {
		async "session.started"(_event, ctx) {
			const experimentPath =
				ctx.session.auth.initiator?.attributes.experimentPath;
			if (typeof experimentPath !== "string" || !experimentPath) return;
			await prepareSubject(experimentPath, ctx);
		},
	},
});
