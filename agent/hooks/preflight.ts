import { defineHook } from "eve/hooks";
import { prepareRun } from "../lib/prepare";

export default defineHook({
	events: {
		async "session.started"(_event, ctx) {
			const attributes = ctx.session.auth.initiator?.attributes;
			const repository = attributes?.repository;
			const sourceSha = attributes?.sourceSha;
			const task = attributes?.task;
			if (
				typeof repository !== "string" ||
				typeof sourceSha !== "string" ||
				!task
			)
				return;
			await prepareRun({ repository, sourceSha, task }, ctx);
		},
	},
});
