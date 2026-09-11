import { defineHook } from "eve/hooks";
import { prepareRun } from "../lib/prepare";

export default defineHook({
	events: {
		async "turn.started"(_event, ctx) {
			const attributes = ctx.session.auth.current?.attributes;
			const runId = attributes?.runId;
			const repository = attributes?.repository;
			const sourceSha = attributes?.sourceSha;
			const task = attributes?.task;
			if (
				typeof runId !== "string" ||
				typeof repository !== "string" ||
				typeof sourceSha !== "string" ||
				!task
			)
				return;
			await prepareRun({ runId, repository, sourceSha, task }, ctx);
		},
	},
});
