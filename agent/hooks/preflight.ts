import { defineHook } from "eve/hooks";
import { prepareRun } from "../lib/prepare";

export default defineHook({
	events: {
		async "turn.started"(_event, ctx) {
			const attributes = ctx.session.auth.current?.attributes;
			const runId = attributes?.runId;
			const repository = attributes?.repository;
			const sourceSha = attributes?.sourceSha;
			const taskJson = attributes?.taskJson;
			if (
				typeof runId !== "string" ||
				typeof repository !== "string" ||
				typeof sourceSha !== "string" ||
				typeof taskJson !== "string"
			)
				return;
			await prepareRun({
				runId,
				repository,
				sourceSha,
				task: JSON.parse(taskJson) as unknown,
			}, ctx);
		},
	},
});
