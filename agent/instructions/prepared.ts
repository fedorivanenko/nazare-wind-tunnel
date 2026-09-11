import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
	events: {
		"turn.started": async (_event, ctx) => {
			const attributes = ctx.session.auth.current?.attributes;
			const runId = attributes?.runId;
			const taskJson = attributes?.taskJson;
			if (typeof runId !== "string" || typeof taskJson !== "string")
				return null;
			let task: unknown;
			try {
				task = JSON.parse(taskJson);
			} catch {
				return null;
			}
			if (!task || typeof task !== "object") return null;
			const agent = (
				task as {
					agent?: {
						prompt?: unknown;
						timeoutMs?: unknown;
						maxToolCalls?: unknown;
					};
				}
			).agent;
			if (!agent || typeof agent.prompt !== "string") return null;
			const timeoutMs =
				typeof agent.timeoutMs === "number" ? agent.timeoutMs : 60_000;
			const maxToolCalls =
				typeof agent.maxToolCalls === "number" ? agent.maxToolCalls : 12;
			return defineInstructions({
				role: "user",
				content: [
					`Task:\n${agent.prompt}`,
					"Repository root: /workspace/repo",
					`Hard execution budget: ${timeoutMs}ms and at most ${maxToolCalls} exploratory/editing tool calls before finish_run.`,
					"Implement the smallest valid change immediately. Prefer direct edits over repository exploration. Call finish_run exactly once when the patch is ready.",
				].join("\n\n"),
			});
		},
	},
});
