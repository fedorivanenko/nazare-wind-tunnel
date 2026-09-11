import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { defineChannel, GET, POST } from "eve/channels";
import { z } from "zod";
import {
	attachSession,
	createRun,
	getRun,
	getRunEvents,
	listRuns,
} from "../lib/database";
import { runTaskSchema } from "../lib/task";

const requestSchema = z.object({
	operationId: z.string().min(1).max(500),
	workspaceId: z.string().min(1).max(200),
	repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
	task: runTaskSchema,
	trigger: z.record(z.string(), z.unknown()).optional(),
});

type RunChannelState = {
	runId: string | null;
	workspaceId: string | null;
	repository: string | null;
	sourceSha: string | null;
};

function authorized(request: Request) {
	const expected = process.env.WIND_TUNNEL_TOKEN ?? "";
	const authorization = request.headers.get("authorization") ?? "";
	const supplied = authorization.startsWith("Bearer ")
		? authorization.slice(7)
		: "";
	const expectedBytes = Buffer.from(expected);
	const suppliedBytes = Buffer.from(supplied);
	return (
		Boolean(expected) &&
		expectedBytes.length === suppliedBytes.length &&
		timingSafeEqual(expectedBytes, suppliedBytes)
	);
}

function requireAuthorization(request: Request) {
	if (authorized(request)) return null;
	return Response.json(
		{ error: "Unauthorized" },
		{ status: 401, headers: { "www-authenticate": "Bearer" } },
	);
}

export default defineChannel<RunChannelState>({
	turnPolicy: "queue",
	state: {
		runId: null,
		workspaceId: null,
		repository: null,
		sourceSha: null,
	},
	metadata(state) {
		return { ...state, audience: "private" as const };
	},
	routes: [
		POST("/api/runs", async (request, { from }) => {
			const unauthorized = requireAuthorization(request);
			if (unauthorized) return unauthorized;
			if (!process.env.DATABASE_URL)
				return Response.json(
					{ error: "Run registry is not configured" },
					{ status: 503 },
				);
			const parsed = requestSchema.safeParse(await request.json());
			if (!parsed.success)
				return Response.json(
					{ error: "Invalid run request", issues: parsed.error.issues },
					{ status: 400 },
				);
			const input = parsed.data;
			const taskSha256 = createHash("sha256")
				.update(JSON.stringify(input.task))
				.digest("hex");
			const requestedId = randomUUID();
			const run = await createRun({
				id: requestedId,
				operationId: input.operationId,
				repository: input.repository,
				sourceSha: input.sourceSha,
				experimentPath: "inline-task",
				archiveSha256: taskSha256,
				request: input,
			});
			if (run.sessionId)
				return Response.json(
					{ runId: run.id, sessionId: run.sessionId, duplicate: true },
					{ status: 200 },
				);
			const session = await from(input.workspaceId).send(
				`Execute this mutation task against ${input.repository}@${input.sourceSha}. Implement immediately, then call finish_run exactly once.`,
				{
					auth: {
						authenticator: "wind-tunnel-token",
						principalId: "api",
						principalType: "service",
						attributes: {
							runId: run.id,
							workspaceId: input.workspaceId,
							repository: input.repository,
							sourceSha: input.sourceSha,
							task: input.task,
						},
					},
					state: {
						runId: run.id,
						workspaceId: input.workspaceId,
						repository: input.repository,
						sourceSha: input.sourceSha,
					},
				},
			);
			await attachSession(run.id, session.id);
			return Response.json(
				{ runId: run.id, sessionId: session.id, taskSha256 },
				{ status: 202 },
			);
		}),
		GET("/api/runs", async (request) => {
			const unauthorized = requireAuthorization(request);
			if (unauthorized) return unauthorized;
			const limit = Number(
				new URL(request.url).searchParams.get("limit") ?? 50,
			);
			return Response.json({ runs: await listRuns(limit) });
		}),
		GET("/api/runs/:id", async (request, { params }) => {
			const unauthorized = requireAuthorization(request);
			if (unauthorized) return unauthorized;
			const run = await getRun(params.id);
			if (!run)
				return Response.json({ error: "Run not found" }, { status: 404 });
			return Response.json({ run, events: await getRunEvents(run.id) });
		}),
	],
});
