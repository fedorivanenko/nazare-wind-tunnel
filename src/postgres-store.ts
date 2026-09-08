import {spawn} from 'node:child_process';
import {withElapsed, type ArtifactRecord, type RunEvent, type RunLifecycle, type RunOutcome, type RunSpec, type RunState} from './domain';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const LEASE_SECONDS = Number(process.env.WIND_TUNNEL_LEASE_SECONDS ?? 90);

function requireDatabaseUrl() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
}

function sqlLiteral(value: string | null) {
  if (value === null) return 'NULL';
  return `'${value.replaceAll("'", "''")}'`;
}

function jsonLiteral(value: unknown) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

async function psql(sql: string) {
  requireDatabaseUrl();
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', DATABASE_URL], {
      env: {...process.env, PAGER: 'cat'},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `psql exited with ${code}`));
    });
    child.stdin.end(sql);
  });
}

function parseState(raw: string): RunState {
  const row = JSON.parse(raw) as {
    run_id: string;
    status: RunLifecycle;
    outcome: RunOutcome;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    updated_at: string;
    error: string | null;
    worker_id: string | null;
    lease_until: string | null;
    attempts: number;
    spec: RunSpec;
    arms: RunState['arms'];
  };
  return withElapsed({
    runId: row.run_id,
    status: row.status,
    outcome: row.outcome,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
    elapsedMs: 0,
    error: row.error,
    workerId: row.worker_id,
    leaseUntil: row.lease_until,
    attempts: row.attempts,
    spec: row.spec,
    arms: row.arms,
  });
}

const STATE_JSON = `json_build_object(
  'run_id', run_id,
  'status', status,
  'outcome', outcome,
  'created_at', created_at,
  'started_at', started_at,
  'finished_at', finished_at,
  'updated_at', updated_at,
  'error', error,
  'worker_id', worker_id,
  'lease_until', lease_until,
  'attempts', attempts,
  'spec', spec,
  'arms', arms
)::text`;

export async function ensureSchema() {
  await psql(`
    CREATE TABLE IF NOT EXISTS wind_tunnel_runs (
      run_id uuid PRIMARY KEY,
      status text NOT NULL,
      outcome text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz NULL,
      finished_at timestamptz NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      error text NULL,
      worker_id text NULL,
      lease_until timestamptz NULL,
      attempts integer NOT NULL DEFAULT 0,
      spec jsonb NOT NULL,
      arms jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wind_tunnel_runs_claim_idx ON wind_tunnel_runs (status, lease_until, created_at);

    CREATE TABLE IF NOT EXISTS wind_tunnel_events (
      seq bigserial PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES wind_tunnel_runs(run_id) ON DELETE CASCADE,
      type text NOT NULL,
      at timestamptz NOT NULL,
      arm text NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS wind_tunnel_events_run_idx ON wind_tunnel_events (run_id, seq);

    CREATE TABLE IF NOT EXISTS wind_tunnel_artifacts (
      run_id uuid NOT NULL REFERENCES wind_tunnel_runs(run_id) ON DELETE CASCADE,
      arm text NULL,
      type text NOT NULL,
      object_key text NOT NULL,
      media_type text NOT NULL,
      bytes bigint NOT NULL,
      sha256 text NOT NULL,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (run_id, object_key)
    );
    CREATE INDEX IF NOT EXISTS wind_tunnel_artifacts_run_idx ON wind_tunnel_artifacts (run_id, arm, type);
  `);
}

export async function createRun(spec: RunSpec, arms: RunState['arms']) {
  const now = new Date().toISOString();
  await psql(`
    INSERT INTO wind_tunnel_runs (run_id, status, created_at, updated_at, spec, arms)
    VALUES (${sqlLiteral(spec.runId)}::uuid, 'queued', ${sqlLiteral(now)}::timestamptz, ${sqlLiteral(now)}::timestamptz, ${jsonLiteral(spec)}, ${jsonLiteral(arms)});
  `);
  await appendEvent({runId: spec.runId, type: 'run.created', at: now, data: {experimentId: spec.experiment.id}});
  return getRun(spec.runId);
}

export async function getRun(runId: string) {
  const raw = await psql(`SELECT ${STATE_JSON} FROM wind_tunnel_runs WHERE run_id = ${sqlLiteral(runId)}::uuid;`);
  if (!raw) throw new Error(`Run not found: ${runId}`);
  return parseState(raw);
}

export async function listActiveRuns() {
  const raw = await psql(`
    SELECT COALESCE(json_agg(state), '[]'::json)::text FROM (
      SELECT ${STATE_JSON} AS state
      FROM wind_tunnel_runs
      WHERE status NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY created_at DESC
    ) q;
  `);
  const rows = JSON.parse(raw || '[]') as string[];
  return rows.map(parseState);
}

export async function listRuns(limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const raw = await psql(`
    SELECT COALESCE(json_agg(state), '[]'::json)::text FROM (
      SELECT ${STATE_JSON} AS state
      FROM wind_tunnel_runs
      ORDER BY created_at DESC
      LIMIT ${safeLimit}
    ) q;
  `);
  const rows = JSON.parse(raw || '[]') as string[];
  return rows.map(parseState);
}

export async function claimNextRun(workerId: string) {
  const raw = await psql(`
    WITH candidate AS (
      SELECT run_id
      FROM wind_tunnel_runs
      WHERE status = 'queued'
         OR (status NOT IN ('completed', 'failed', 'cancelled') AND lease_until IS NOT NULL AND lease_until < now())
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    ), claimed AS (
      UPDATE wind_tunnel_runs r
      SET worker_id = ${sqlLiteral(workerId)},
          lease_until = now() + interval '${Math.max(30, LEASE_SECONDS)} seconds',
          attempts = attempts + 1,
          status = CASE WHEN status = 'queued' THEN 'preparing' ELSE status END,
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      FROM candidate c
      WHERE r.run_id = c.run_id
      RETURNING r.*
    )
    SELECT ${STATE_JSON} FROM claimed;
  `);
  return raw ? parseState(raw) : null;
}

export async function renewLease(runId: string, workerId: string) {
  const raw = await psql(`
    UPDATE wind_tunnel_runs
    SET lease_until = now() + interval '${Math.max(30, LEASE_SECONDS)} seconds', updated_at = now()
    WHERE run_id = ${sqlLiteral(runId)}::uuid AND worker_id = ${sqlLiteral(workerId)}
      AND status NOT IN ('completed', 'failed', 'cancelled')
    RETURNING run_id::text;
  `);
  if (!raw) throw new Error(`Lease lost for run ${runId}`);
}

export async function saveRunState(state: RunState) {
  const now = new Date().toISOString();
  const terminal = ['completed', 'failed', 'cancelled'].includes(state.status);
  const finishedAt = terminal ? (state.finishedAt ?? now) : state.finishedAt;
  const raw = await psql(`
    UPDATE wind_tunnel_runs
    SET status = ${sqlLiteral(state.status)},
        outcome = ${sqlLiteral(state.outcome)},
        started_at = ${sqlLiteral(state.startedAt)}::timestamptz,
        finished_at = ${sqlLiteral(finishedAt)}::timestamptz,
        updated_at = ${sqlLiteral(now)}::timestamptz,
        error = ${sqlLiteral(state.error)},
        lease_until = CASE WHEN ${terminal ? 'TRUE' : 'FALSE'} THEN NULL ELSE lease_until END,
        arms = ${jsonLiteral(state.arms)}
    WHERE run_id = ${sqlLiteral(state.runId)}::uuid
    RETURNING ${STATE_JSON};
  `);
  if (!raw) throw new Error(`Run not found: ${state.runId}`);
  return parseState(raw);
}

export async function appendEvent(event: RunEvent) {
  await psql(`
    INSERT INTO wind_tunnel_events (run_id, type, at, arm, data)
    VALUES (${sqlLiteral(event.runId)}::uuid, ${sqlLiteral(event.type)}, ${sqlLiteral(event.at)}::timestamptz, ${sqlLiteral(event.arm ?? null)}, ${jsonLiteral(event.data ?? {})});
  `);
}

export async function getEvents(runId: string) {
  const raw = await psql(`
    SELECT COALESCE(json_agg(json_build_object(
      'seq', seq, 'runId', run_id::text, 'type', type, 'at', at, 'arm', arm, 'data', data
    ) ORDER BY seq), '[]'::json)::text
    FROM wind_tunnel_events WHERE run_id = ${sqlLiteral(runId)}::uuid;
  `);
  return JSON.parse(raw || '[]') as RunEvent[];
}

export async function registerArtifact(record: ArtifactRecord) {
  await psql(`
    INSERT INTO wind_tunnel_artifacts (run_id, arm, type, object_key, media_type, bytes, sha256, created_at)
    VALUES (${sqlLiteral(record.runId)}::uuid, ${sqlLiteral(record.arm)}, ${sqlLiteral(record.type)}, ${sqlLiteral(record.key)}, ${sqlLiteral(record.mediaType)}, ${record.bytes}, ${sqlLiteral(record.sha256)}, ${sqlLiteral(record.createdAt)}::timestamptz)
    ON CONFLICT (run_id, object_key) DO UPDATE SET
      arm = EXCLUDED.arm, type = EXCLUDED.type, media_type = EXCLUDED.media_type,
      bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, created_at = EXCLUDED.created_at;
  `);
}

export async function listArtifacts(runId: string, arm?: string) {
  const filter = arm ? `AND arm = ${sqlLiteral(arm)}` : '';
  const raw = await psql(`
    SELECT COALESCE(json_agg(json_build_object(
      'runId', run_id::text, 'arm', arm, 'type', type, 'key', object_key,
      'mediaType', media_type, 'bytes', bytes, 'sha256', sha256, 'createdAt', created_at
    ) ORDER BY created_at, object_key), '[]'::json)::text
    FROM wind_tunnel_artifacts WHERE run_id = ${sqlLiteral(runId)}::uuid ${filter};
  `);
  return JSON.parse(raw || '[]') as ArtifactRecord[];
}
