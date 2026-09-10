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

const requestSchema = z.object({
	operationId: z.string().min(1).max(500),
	repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
	experimentPath: z.string().min(1).max(500),
	archiveBase64: z.string().min(1),
	archiveSha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	trigger: z.record(z.string(), z.unknown()).optional(),
});

type RunChannelState = {
	runId: string | null;
	repository: string | null;
	sourceSha: string | null;
	experimentPath: string | null;
	archiveSha256: string | null;
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
		repository: null,
		sourceSha: null,
		experimentPath: null,
		archiveSha256: null,
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
			const archive = Buffer.from(input.archiveBase64, "base64");
			const archiveSha256 = createHash("sha256").update(archive).digest("hex");
			if (input.archiveSha256 && input.archiveSha256 !== archiveSha256)
				return Response.json(
					{ error: "Archive digest mismatch" },
					{ status: 400 },
				);
			const requestedId = randomUUID();
			const run = await createRun({
				id: requestedId,
				operationId: input.operationId,
				repository: input.repository,
				sourceSha: input.sourceSha,
				experimentPath: input.experimentPath,
				archiveSha256,
				request: {
					...input,
					archiveBase64: "[attachment omitted]",
					archiveSha256,
				},
			});
			if (run.sessionId)
				return Response.json(
					{ runId: run.id, sessionId: run.sessionId, duplicate: true },
					{ status: 200 },
				);
			const session = await from(input.operationId).send(
				[
					{
						type: "text",
						text: `Implement Wind Tunnel experiment ${input.experimentPath} for ${input.repository} at exact source SHA ${input.sourceSha}. First call prepare_subject with this experiment path. After implementation call finish_run exactly once.`,
					},
					{
						type: "file",
						data: archive,
						mediaType: "application/gzip",
						filename: "source.tar.gz",
					},
				],
				{
					auth: {
						authenticator: "wind-tunnel-token",
						principalId: "github-actions",
						principalType: "service",
						attributes: {},
					},
					state: {
						runId: run.id,
						repository: input.repository,
						sourceSha: input.sourceSha,
						experimentPath: input.experimentPath,
						archiveSha256,
					},
				},
			);
			await attachSession(run.id, session.id);
			return Response.json(
				{ runId: run.id, sessionId: session.id, archiveSha256 },
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
