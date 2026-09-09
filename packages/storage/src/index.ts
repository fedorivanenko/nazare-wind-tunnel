import {createHash, createHmac} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {ArtifactRecord, RunEvent, RunLifecycle, RunOutcome, RunSpec, RunState} from '@nazare/wind-tunnel-domain';
import {withElapsed} from '@nazare/wind-tunnel-domain';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const LEASE_SECONDS = Number(process.env.WIND_TUNNEL_LEASE_SECONDS ?? 90);
const BUCKET = process.env.WIND_TUNNEL_S3_BUCKET ?? '';
const ENDPOINT = process.env.WIND_TUNNEL_S3_ENDPOINT ?? '';
const REGION = process.env.WIND_TUNNEL_S3_REGION ?? 'auto';
const ACCESS_KEY = process.env.WIND_TUNNEL_S3_ACCESS_KEY ?? '';
const SECRET_KEY = process.env.WIND_TUNNEL_S3_SECRET_KEY ?? '';

function sqlLiteral(value: string | null) {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

function jsonLiteral(value: unknown) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

async function psql(sql: string) {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', DATABASE_URL], {
      env: {...process.env, PAGER: 'cat'}, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `psql exited with ${code}`)));
    child.stdin.end(sql);
  });
}

function parseState(raw: string): RunState {
  const row = JSON.parse(raw) as {
    run_id: string; status: RunLifecycle; outcome: RunOutcome; created_at: string; started_at: string | null;
    finished_at: string | null; updated_at: string; error: string | null; worker_id: string | null;
    lease_until: string | null; attempts: number; spec: RunSpec;
  };
  return withElapsed({
    runId: row.run_id, status: row.status, outcome: row.outcome, createdAt: row.created_at, startedAt: row.started_at,
    finishedAt: row.finished_at, updatedAt: row.updated_at, elapsedMs: 0, error: row.error, workerId: row.worker_id,
    leaseUntil: row.lease_until, attempts: row.attempts, spec: row.spec,
  });
}

const STATE_JSON = `json_build_object(
  'run_id', run_id, 'status', status, 'outcome', outcome, 'created_at', created_at,
  'started_at', started_at, 'finished_at', finished_at, 'updated_at', updated_at,
  'error', error, 'worker_id', worker_id, 'lease_until', lease_until, 'attempts', attempts, 'spec', spec
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
      spec jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wind_tunnel_runs_claim_idx ON wind_tunnel_runs (status, lease_until, created_at);
    CREATE INDEX IF NOT EXISTS wind_tunnel_runs_subject_idx ON wind_tunnel_runs ((spec->'subject'->>'repository'), (spec->'subject'->>'githubSha'), (spec->'experiment'->>'path'), (spec->>'arm'));

    CREATE TABLE IF NOT EXISTS wind_tunnel_events (
      seq bigserial PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES wind_tunnel_runs(run_id) ON DELETE CASCADE,
      type text NOT NULL,
      at timestamptz NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS wind_tunnel_artifacts (
      run_id uuid NOT NULL REFERENCES wind_tunnel_runs(run_id) ON DELETE CASCADE,
      type text NOT NULL,
      object_key text NOT NULL,
      media_type text NOT NULL,
      bytes bigint NOT NULL,
      sha256 text NOT NULL,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (run_id, object_key)
    );
  `);
}

export async function createRun(spec: RunSpec) {
  const now = new Date().toISOString();
  const duplicate = await psql(`
    SELECT run_id::text FROM wind_tunnel_runs
    WHERE status NOT IN ('completed','failed','cancelled')
      AND spec->'subject'->>'repository' = ${sqlLiteral(spec.subject.repository)}
      AND spec->'subject'->>'githubSha' = ${sqlLiteral(spec.subject.githubSha)}
      AND spec->'experiment'->>'path' = ${sqlLiteral(spec.experiment.path)}
      AND spec->>'arm' = ${sqlLiteral(spec.arm)}
    ORDER BY created_at DESC LIMIT 1;
  `);
  if (duplicate) return getRun(duplicate);

  await psql(`INSERT INTO wind_tunnel_runs (run_id,status,created_at,updated_at,spec)
    VALUES (${sqlLiteral(spec.runId)}::uuid,'queued',${sqlLiteral(now)}::timestamptz,${sqlLiteral(now)}::timestamptz,${jsonLiteral(spec)});`);
  await appendEvent({runId: spec.runId, type: 'run.created', at: now, data: {repository: spec.subject.repository, arm: spec.arm}});
  return getRun(spec.runId);
}

export async function getRun(runId: string) {
  const raw = await psql(`SELECT ${STATE_JSON} FROM wind_tunnel_runs WHERE run_id=${sqlLiteral(runId)}::uuid;`);
  if (!raw) throw new Error(`Run not found: ${runId}`);
  return parseState(raw);
}

export async function claimNextRun(workerId: string) {
  const raw = await psql(`WITH candidate AS (
      SELECT run_id FROM wind_tunnel_runs
      WHERE status='queued' OR (status NOT IN ('completed','failed','cancelled') AND lease_until IS NOT NULL AND lease_until < now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE wind_tunnel_runs r SET worker_id=${sqlLiteral(workerId)}, lease_until=now()+interval '${Math.max(30, LEASE_SECONDS)} seconds',
        attempts=attempts+1, status=CASE WHEN status='queued' THEN 'preparing' ELSE status END,
        started_at=COALESCE(started_at,now()), updated_at=now()
      FROM candidate c WHERE r.run_id=c.run_id RETURNING r.*
    ) SELECT ${STATE_JSON} FROM claimed;`);
  return raw ? parseState(raw) : null;
}

export async function renewLease(runId: string, workerId: string) {
  const raw = await psql(`UPDATE wind_tunnel_runs SET lease_until=now()+interval '${Math.max(30, LEASE_SECONDS)} seconds', updated_at=now()
    WHERE run_id=${sqlLiteral(runId)}::uuid AND worker_id=${sqlLiteral(workerId)} AND status NOT IN ('completed','failed','cancelled') RETURNING run_id::text;`);
  if (!raw) throw new Error(`Lease lost for run ${runId}`);
}

export async function saveRun(state: RunState) {
  const now = new Date().toISOString();
  const terminal = ['completed','failed','cancelled'].includes(state.status);
  const finishedAt = terminal ? (state.finishedAt ?? now) : state.finishedAt;
  const raw = await psql(`UPDATE wind_tunnel_runs SET status=${sqlLiteral(state.status)}, outcome=${sqlLiteral(state.outcome)},
    started_at=${sqlLiteral(state.startedAt)}::timestamptz, finished_at=${sqlLiteral(finishedAt)}::timestamptz,
    updated_at=${sqlLiteral(now)}::timestamptz, error=${sqlLiteral(state.error)},
    lease_until=CASE WHEN ${terminal ? 'TRUE' : 'FALSE'} THEN NULL ELSE lease_until END
    WHERE run_id=${sqlLiteral(state.runId)}::uuid RETURNING ${STATE_JSON};`);
  if (!raw) throw new Error(`Run not found: ${state.runId}`);
  return parseState(raw);
}

export async function appendEvent(event: RunEvent) {
  await psql(`INSERT INTO wind_tunnel_events (run_id,type,at,data)
    VALUES (${sqlLiteral(event.runId)}::uuid,${sqlLiteral(event.type)},${sqlLiteral(event.at)}::timestamptz,${jsonLiteral(event.data ?? {})});`);
}

export async function listArtifacts(runId: string) {
  const raw = await psql(`SELECT COALESCE(json_agg(json_build_object(
    'runId',run_id::text,'type',type,'key',object_key,'mediaType',media_type,'bytes',bytes,'sha256',sha256,'createdAt',created_at
  ) ORDER BY created_at,object_key),'[]'::json)::text FROM wind_tunnel_artifacts WHERE run_id=${sqlLiteral(runId)}::uuid;`);
  return JSON.parse(raw || '[]') as ArtifactRecord[];
}

export async function registerArtifact(record: ArtifactRecord) {
  await psql(`INSERT INTO wind_tunnel_artifacts (run_id,type,object_key,media_type,bytes,sha256,created_at)
    VALUES (${sqlLiteral(record.runId)}::uuid,${sqlLiteral(record.type)},${sqlLiteral(record.key)},${sqlLiteral(record.mediaType)},${record.bytes},${sqlLiteral(record.sha256)},${sqlLiteral(record.createdAt)}::timestamptz)
    ON CONFLICT (run_id,object_key) DO NOTHING;`);
}

function sha256(value: Buffer | string) { return createHash('sha256').update(value).digest('hex'); }
function hmac(key: Buffer | string, value: string) { return createHmac('sha256', key).update(value).digest(); }

function objectUrl(key: string) {
  if (!BUCKET || !ENDPOINT || !ACCESS_KEY || !SECRET_KEY) throw new Error('Wind Tunnel S3 configuration is incomplete');
  const url = new URL(ENDPOINT);
  url.hostname = `${BUCKET}.${url.hostname}`;
  url.pathname = `/${key.split('/').map(encodeURIComponent).join('/')}`;
  url.search = '';
  return url;
}

async function signedPut(key: string, body: Buffer, mediaType: string) {
  const url = objectUrl(key);
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = iso.slice(0, 8);
  const payloadHash = sha256(body);
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${iso}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT',url.pathname,'',canonicalHeaders,signedHeaders,payloadHash].join('\n');
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256',iso,scope,sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${SECRET_KEY}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(url, {method:'PUT', headers:{authorization,'x-amz-date':iso,'x-amz-content-sha256':payloadHash,'content-type':mediaType}, body:new Uint8Array(body)});
  if (!response.ok) throw new Error(`S3 PUT failed: ${response.status} ${await response.text()}`);
}

function redactText(text: string) {
  let redacted = text;
  for (const [name,value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !/(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|DATABASE_URL)/i.test(name)) continue;
    redacted = redacted.split(value).join('[REDACTED]');
  }
  return redacted.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, '$1[REDACTED]');
}

export async function putArtifact(input: {runId:string; type:string; name:string; mediaType:string; content:string|Buffer; redact?:boolean}) {
  const raw = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
  const content = input.redact === false || Buffer.isBuffer(input.content) ? raw : Buffer.from(redactText(raw.toString('utf8')));
  const digest = sha256(content);
  const key = `${input.runId}/${digest}/${input.name}`;
  await signedPut(key, content, input.mediaType);
  const record: ArtifactRecord = {runId:input.runId,type:input.type,key,mediaType:input.mediaType,bytes:content.byteLength,sha256:digest,createdAt:new Date().toISOString()};
  await registerArtifact(record);
  return record;
}
