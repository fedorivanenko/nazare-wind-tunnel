import postgres from "postgres";

export type RunRecord = {
	id: string;
	operationId: string;
	sessionId: string | null;
	status: string;
	repository: string;
	sourceSha: string;
	experimentPath: string;
	archiveSha256: string;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
	result: unknown;
	error: unknown;
};

let client: ReturnType<typeof postgres> | null = null;
let initialized: Promise<void> | null = null;

function sql() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL is required");
	client ??= postgres(url, { max: 4, prepare: false });
	return client;
}

async function initialize() {
	if (initialized) return initialized;
	initialized = (async () => {
		const database = sql();
		await database`
			create table if not exists wind_tunnel_runs (
				id uuid primary key,
				operation_id text not null unique,
				session_id text unique,
				status text not null,
				repository text not null,
				source_sha text not null,
				experiment_path text not null,
				archive_sha256 text not null,
				request jsonb not null,
				result jsonb,
				error jsonb,
				created_at timestamptz not null default now(),
				updated_at timestamptz not null default now(),
				finished_at timestamptz
			)
		`;
		await database`
			create table if not exists wind_tunnel_events (
				id text primary key,
				run_id uuid references wind_tunnel_runs(id) on delete cascade,
				session_id text not null,
				type text not null,
				data jsonb,
				emitted_at timestamptz not null,
				recorded_at timestamptz not null default now()
			)
		`;
		await database`create index if not exists wind_tunnel_events_run_at on wind_tunnel_events(run_id, emitted_at)`;
	})();
	return initialized;
}

function mapRun(row: Record<string, unknown>): RunRecord {
	return {
		id: String(row.id),
		operationId: String(row.operation_id),
		sessionId: row.session_id ? String(row.session_id) : null,
		status: String(row.status),
		repository: String(row.repository),
		sourceSha: String(row.source_sha),
		experimentPath: String(row.experiment_path),
		archiveSha256: String(row.archive_sha256),
		createdAt: new Date(String(row.created_at)).toISOString(),
		updatedAt: new Date(String(row.updated_at)).toISOString(),
		finishedAt: row.finished_at
			? new Date(String(row.finished_at)).toISOString()
			: null,
		result: row.result ?? null,
		error: row.error ?? null,
	};
}

export async function createRun(input: {
	id: string;
	operationId: string;
	repository: string;
	sourceSha: string;
	experimentPath: string;
	archiveSha256: string;
	request: unknown;
}) {
	await initialize();
	const rows = await sql()`
		insert into wind_tunnel_runs (id, operation_id, status, repository, source_sha, experiment_path, archive_sha256, request)
		values (${input.id}, ${input.operationId}, 'accepted', ${input.repository}, ${input.sourceSha}, ${input.experimentPath}, ${input.archiveSha256}, ${sql().json(input.request as never)})
		on conflict (operation_id) do update set updated_at = now()
		returning *
	`;
	return mapRun(rows[0]);
}

export async function attachSession(runId: string, sessionId: string) {
	await initialize();
	await sql()`update wind_tunnel_runs set session_id=${sessionId}, status='preparing', updated_at=now() where id=${runId}`;
}

export async function listRuns(limit = 50) {
	await initialize();
	const rows =
		await sql()`select * from wind_tunnel_runs order by created_at desc limit ${Math.min(100, Math.max(1, limit))}`;
	return rows.map(mapRun);
}

export async function getRun(id: string) {
	await initialize();
	const rows =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			id,
		)
			? await sql()`select * from wind_tunnel_runs where id=${id} limit 1`
			: await sql()`select * from wind_tunnel_runs where session_id=${id} limit 1`;
	return rows[0] ? mapRun(rows[0]) : null;
}

export async function getRunEvents(runId: string, limit = 2_000) {
	await initialize();
	return sql()`select id, session_id as "sessionId", type, data, emitted_at as "at" from wind_tunnel_events where run_id=${runId} order by emitted_at asc limit ${Math.min(5_000, Math.max(1, limit))}`;
}

export async function persistEvent(input: {
	id: string;
	sessionId: string;
	type: string;
	data: unknown;
	at: string;
}) {
	await initialize();
	const database = sql();
	await database`
		insert into wind_tunnel_events (id, run_id, session_id, type, data, emitted_at)
		select ${input.id}, id, ${input.sessionId}, ${input.type}, ${database.json((input.data ?? null) as never)}, ${input.at}
		from wind_tunnel_runs where session_id=${input.sessionId}
		on conflict (id) do nothing
	`;
	if (input.type === "session.waiting") {
		await database`
			update wind_tunnel_runs
			set status=case when result is null then 'failed' else status end,
				error=case when result is null then ${database.json({ code: "missing_finish_run", message: "Session parked without finish_run evidence" })} else error end,
				updated_at=now(), finished_at=coalesce(finished_at, now())
			where session_id=${input.sessionId}
		`;
		return;
	}
	const status = eventStatus(input.type);
	if (!status) return;
	const terminal =
		status === "completed" || status === "failed" || status === "cancelled";
	if (terminal) {
		await database`
			update wind_tunnel_runs
			set status=${status}, updated_at=now(), finished_at=now()
			where session_id=${input.sessionId}
		`;
	} else {
		await database`
			update wind_tunnel_runs
			set status=${status}, updated_at=now()
			where session_id=${input.sessionId} and status not in ('completed','failed','cancelled')
		`;
	}
}

export async function finishRun(sessionId: string, result: unknown) {
	await initialize();
	const database = sql();
	const passed = Boolean((result as { passed?: unknown } | null)?.passed);
	await database`
		update wind_tunnel_runs set status=${passed ? "completed" : "failed"}, result=${database.json(result as never)}, updated_at=now(), finished_at=now()
		where session_id=${sessionId}
	`;
}

function eventStatus(type: string) {
	if (type === "session.started") return "preparing";
	if (type === "step.started") return "running";
	if (type === "turn.failed" || type === "session.failed") return "failed";
	if (type === "turn.cancelled") return "cancelled";
	if (type === "session.completed") return "completed";
	return null;
}
