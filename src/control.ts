import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {getArtifact} from './artifact-store';
import {
  defaultEnvironments,
  normalizeVerification,
  type Arm,
  type ArmState,
  type EnvironmentSpec,
  type ExperimentDefinition,
  type RunSpec,
} from './domain';
import {
  createRun,
  ensureSchema,
  getEvents,
  getRun,
  listActiveRuns,
  listArtifacts,
  listRuns,
} from './postgres-store';

const PORT = Number(process.env.PORT ?? 3001);
const APP_DIR = process.env.WIND_TUNNEL_APP_DIR ?? '/app';
const EVALUATOR_REPO = process.env.WIND_TUNNEL_EVALUATOR_REPO ?? 'fedorivanenko/nazare-wind-tunnel';
const EVALUATOR_SHA = process.env.WIND_TUNNEL_EVALUATOR_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? 'local';
const SUBJECT_REPO = process.env.WIND_TUNNEL_SUBJECT_REPO ?? 'fedorivanenko/nazare-hydrogen';
const SUBJECT_REF = process.env.WIND_TUNNEL_SUBJECT_REF ?? 'main';
const TOKEN = process.env.WIND_TUNNEL_TOKEN;
const PI_PACKAGE = process.env.WIND_TUNNEL_PI_PACKAGE ?? '@earendil-works/pi-coding-agent@0.85.1';
const WORKER_IMAGE_DIGEST = process.env.WIND_TUNNEL_WORKER_IMAGE_DIGEST ?? 'local';
const DEFAULT_EXPERIMENT = 'experiments/luna-operability/experiment-02-marketing-consent.json';
const MAX_BODY_BYTES = 1_000_000;

type JsonRpcRequest = {jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>};
type ExperimentInfo = {
  name: string;
  id: string;
  taskFile: string;
  agent: ExperimentDefinition['agent'];
  environments: Record<string, EnvironmentSpec>;
  verification: ReturnType<typeof normalizeVerification>;
  definition: ExperimentDefinition;
};

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

function rpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return {jsonrpc: '2.0', id: id ?? null, result};
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown) {
  return {jsonrpc: '2.0', id: id ?? null, error: {code, message, ...(data === undefined ? {} : {data})}};
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req: IncomingMessage): Promise<JsonRpcRequest> {
  return JSON.parse(await readBody(req)) as JsonRpcRequest;
}

function safeEvaluatorPath(relativePath: string) {
  const root = path.resolve(APP_DIR);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Path must stay inside evaluator source');
  return resolved;
}

async function listExperimentFiles() {
  const root = path.join(APP_DIR, 'experiments');
  const files: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
    }
  }
  await walk(root);
  return files.sort();
}

async function loadExperiment(name: string): Promise<ExperimentInfo> {
  for (const full of await listExperimentFiles()) {
    const relative = path.relative(APP_DIR, full);
    const raw = await readFile(full, 'utf8');
    let definition: ExperimentDefinition;
    try { definition = JSON.parse(raw) as ExperimentDefinition; }
    catch { continue; }
    if (!definition.id || !definition.taskFile || !Array.isArray(definition.verification)) continue;
    if (name !== relative && name !== definition.id && name !== path.basename(relative)) continue;
    return {
      name: relative,
      id: definition.id,
      taskFile: definition.taskFile,
      agent: definition.agent,
      environments: defaultEnvironments(definition),
      verification: normalizeVerification(definition),
      definition,
    };
  }
  throw new Error(`Experiment not found: ${name}`);
}

async function listExperiments() {
  const experiments = [];
  for (const full of await listExperimentFiles()) {
    const relative = path.relative(APP_DIR, full);
    try {
      const experiment = await loadExperiment(relative);
      experiments.push({
        name: experiment.name,
        id: experiment.id,
        taskFile: experiment.taskFile,
        agent: experiment.agent,
        environments: experiment.environments,
        verification: experiment.verification,
      });
    } catch {}
  }
  return {experiments};
}

function parseArms(value: unknown, environments: Record<string, EnvironmentSpec>): Arm[] {
  const available = Object.keys(environments);
  const requested = Array.isArray(value) ? value.map(String) : available;
  const arms = [...new Set(requested)];
  if (!arms.length) throw new Error('arms must contain at least one environment id');
  const unknown = arms.filter(item => !environments[item]);
  if (unknown.length) throw new Error(`Unknown environment arm(s): ${unknown.join(', ')}. Available: ${available.join(', ')}`);
  return arms;
}

async function resolveSubjectSha(requested?: string) {
  if (requested && /^[a-f0-9]{40}$/i.test(requested)) return requested.toLowerCase();
  const ref = requested || SUBJECT_REF;
  const remote = `https://github.com/${SUBJECT_REPO}.git`;
  const target = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['ls-remote', remote, target], {env: process.env});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      const sha = stdout.trim().split(/\s+/)[0] ?? '';
      if (code === 0 && /^[a-f0-9]{40}$/i.test(sha)) resolve(sha.toLowerCase());
      else reject(new Error(stderr.trim() || `Could not resolve ${SUBJECT_REPO}@${ref}`));
    });
  });
}

async function startExperiment(args: Record<string, unknown>) {
  if (EVALUATOR_SHA === 'local' && process.env.RAILWAY_ENVIRONMENT) {
    throw new Error('Evaluator SHA is unavailable in Railway; refusing unverifiable run');
  }
  const experiment = await loadExperiment(String(args.experiment ?? DEFAULT_EXPERIMENT));
  const arms = parseArms(args.arms, experiment.environments);
  const rawDefinition = await readFile(safeEvaluatorPath(experiment.name), 'utf8');
  const task = await readFile(safeEvaluatorPath(experiment.taskFile), 'utf8');
  const subjectSha = await resolveSubjectSha(args.subjectSha ? String(args.subjectSha) : undefined);
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const environments = Object.fromEntries(arms.map(arm => [arm, experiment.environments[arm]]));
  const spec: RunSpec = {
    runId,
    evaluator: {
      repository: EVALUATOR_REPO,
      githubSha: EVALUATOR_SHA,
      experimentDigest: sha256(rawDefinition),
      taskDigest: sha256(task),
    },
    subject: {repository: SUBJECT_REPO, githubSha: subjectSha},
    experiment: {path: experiment.name, id: experiment.id},
    task: {path: experiment.taskFile},
    arms,
    environments,
    agent: {
      harness: experiment.agent.harness ?? 'pi',
      package: experiment.agent.package ?? PI_PACKAGE,
      provider: experiment.agent.provider ?? null,
      model: experiment.agent.model ?? null,
      thinking: experiment.agent.thinking ?? null,
      timeoutMs: Number(experiment.agent.timeoutMs ?? 15 * 60 * 1000),
    },
    verification: experiment.verification,
    execution: {workerImageDigest: WORKER_IMAGE_DIGEST},
    controls: {
      subjectSource: 'identical',
      evaluator: 'immutable',
      task: 'identical',
      harness: 'identical',
      model: 'identical',
      provider: 'identical',
      workerImage: 'identical',
      independentVariable: 'environmentCompiler',
    },
    createdAt,
  };
  const armStates = Object.fromEntries(arms.map(arm => [arm, {
    arm,
    status: 'queued',
    outcome: null,
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    error: null,
    failureKind: null,
    workspaceBaselineCommit: null,
  } satisfies ArmState]));
  await createRun(spec, armStates);
  return {
    runId,
    status: 'queued',
    subjectSha,
    evaluatorSha: EVALUATOR_SHA,
    workerImageDigest: WORKER_IMAGE_DIGEST,
    experimentDigest: spec.evaluator.experimentDigest,
    taskDigest: spec.evaluator.taskDigest,
    arms,
    environments,
  };
}

async function getRunView(runId: string) {
  const [run, events, artifacts] = await Promise.all([getRun(runId), getEvents(runId), listArtifacts(runId)]);
  return {run, events, artifacts};
}

async function getRunArtifacts(runId: string, arm?: Arm, inline = true) {
  const records = await listArtifacts(runId, arm);
  if (!inline) return {runId, artifacts: records};
  const artifacts = [];
  for (const record of records) artifacts.push(await getArtifact(record));
  return {runId, artifacts};
}

async function workspaceStatus() {
  const active = await listActiveRuns();
  return {
    controller: 'wind-tunnel-control',
    version: '3.0.0',
    evaluator: {repository: EVALUATOR_REPO, sha: EVALUATOR_SHA},
    subject: {repository: SUBJECT_REPO, defaultRef: SUBJECT_REF},
    execution: {workerImageDigest: WORKER_IMAGE_DIGEST},
    activeRuns: active.map(run => ({
      runId: run.runId,
      status: run.status,
      elapsedMs: run.elapsedMs,
      workerId: run.workerId,
      leaseUntil: run.leaseUntil,
      subjectSha: run.spec.subject.githubSha,
      evaluatorSha: run.spec.evaluator.githubSha,
      workerImageDigest: run.spec.execution?.workerImageDigest ?? null,
    })),
    persistence: {runs: 'postgres', artifacts: 's3'},
  };
}

const tools = [
  {name: 'workspace_status', description: 'Inspect evaluator provenance, subject repository configuration, worker image provenance, and active durable runs.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}},
  {name: 'list_experiments', description: 'List immutable benchmark definitions and available environment versions.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}},
  {name: 'get_experiment', description: 'Inspect a benchmark definition, environment versions, and normalized verifier configuration.', inputSchema: {type: 'object', required: ['name'], properties: {name: {type: 'string'}}, additionalProperties: false}},
  {name: 'start_experiment', description: 'Freeze evaluatorSha + subjectSha + worker image + environment versions into an immutable RunSpec and enqueue it.', inputSchema: {type: 'object', properties: {experiment: {type: 'string'}, subjectSha: {type: 'string', description: 'Optional exact 40-character subject SHA or branch ref. Defaults to configured subject ref.'}, arms: {type: 'array', items: {type: 'string'}, description: 'Environment ids defined by the experiment, e.g. raw or nazare-projection-v1.'}}, additionalProperties: false}},
  {name: 'get_run_status', description: 'Read durable lifecycle, per-arm progress, elapsed time, outcome, worker lease and immutable provenance.', inputSchema: {type: 'object', required: ['runId'], properties: {runId: {type: 'string'}}, additionalProperties: false}},
  {name: 'get_run', description: 'Read a run at any lifecycle stage, including events and artifact manifest.', inputSchema: {type: 'object', required: ['runId'], properties: {runId: {type: 'string'}}, additionalProperties: false}},
  {name: 'get_run_artifacts', description: 'Retrieve immutable artifacts and hashes, optionally scoped to any configured arm.', inputSchema: {type: 'object', required: ['runId'], properties: {runId: {type: 'string'}, arm: {type: 'string'}, inline: {type: 'boolean'}}, additionalProperties: false}},
  {name: 'list_runs', description: 'List recent runs for dashboards and inspection.', inputSchema: {type: 'object', properties: {limit: {type: 'number'}}, additionalProperties: false}},
] as const;

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'workspace_status': return workspaceStatus();
    case 'list_experiments': return listExperiments();
    case 'get_experiment': return loadExperiment(String(args.name ?? ''));
    case 'start_experiment': return startExperiment(args);
    case 'get_run_status': return getRun(String(args.runId ?? ''));
    case 'get_run': return getRunView(String(args.runId ?? ''));
    case 'get_run_artifacts': return getRunArtifacts(String(args.runId ?? ''), args.arm ? String(args.arm) : undefined, args.inline !== false);
    case 'list_runs': return listRuns(Number(args.limit ?? 50));
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function isAuthorized(req: IncomingMessage) {
  return Boolean(TOKEN) && req.headers.authorization === `Bearer ${TOKEN}`;
}

async function handleRpc(req: IncomingMessage, res: ServerResponse) {
  if (!isAuthorized(req)) {
    json(res, TOKEN ? 401 : 503, {error: TOKEN ? 'unauthorized' : 'WIND_TUNNEL_TOKEN is not configured'});
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('allow', 'POST');
    res.end();
    return;
  }
  let body: JsonRpcRequest;
  try { body = await readJsonBody(req); }
  catch (error) { json(res, 400, rpcError(null, -32700, 'Parse error', String(error))); return; }
  if (body.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
  try {
    switch (body.method) {
      case 'initialize':
        json(res, 200, rpcResult(body.id, {
          protocolVersion: String(body.params?.protocolVersion ?? '2025-06-18'),
          capabilities: {tools: {listChanged: false}},
          serverInfo: {name: 'nazare-wind-tunnel', version: '3.0.0'},
          instructions: 'Independent environment-compiler benchmark. Each run freezes evaluator, subject, worker image, model/harness and environment versions; workers use disposable subject workspaces; artifacts are persisted to S3.',
        }));
        return;
      case 'ping': json(res, 200, rpcResult(body.id, {})); return;
      case 'tools/list': json(res, 200, rpcResult(body.id, {tools})); return;
      case 'tools/call': {
        const result = await callTool(String(body.params?.name ?? ''), (body.params?.arguments ?? {}) as Record<string, unknown>);
        const structuredContent = Array.isArray(result) ? {items: result} : result;
        json(res, 200, rpcResult(body.id, {content: [{type: 'text', text: JSON.stringify(result, null, 2)}], structuredContent, isError: false}));
        return;
      }
      default: json(res, 200, rpcError(body.id, -32601, `Method not found: ${body.method}`));
    }
  } catch (error) {
    json(res, 200, rpcResult(body.id, {content: [{type: 'text', text: error instanceof Error ? error.message : String(error)}], isError: true}));
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!isAuthorized(req)) return json(res, 401, {error: 'unauthorized'});
  if (req.method !== 'GET') return json(res, 405, {error: 'method_not_allowed'});
  if (url.pathname === '/api/runs') return json(res, 200, await listRuns(Number(url.searchParams.get('limit') ?? 50)));
  if (url.pathname === '/api/experiments') return json(res, 200, await listExperiments());
  const match = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)$/i);
  if (match) return json(res, 200, await getRunView(match[1]));
  return json(res, 404, {error: 'not_found'});
}

await ensureSchema();

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/health') {
    try { json(res, 200, {ok: true, ...(await workspaceStatus())}); }
    catch (error) { json(res, 503, {ok: false, error: error instanceof Error ? error.message : String(error)}); }
    return;
  }
  if (url.pathname === '/mcp') { await handleRpc(req, res); return; }
  if (url.pathname.startsWith('/api/')) { await handleApi(req, res, url); return; }
  res.statusCode = 404;
  res.end();
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Nazare Wind Tunnel control v3 listening on ${PORT}`);
  console.log(`Evaluator: ${EVALUATOR_REPO}@${EVALUATOR_SHA}`);
  console.log(`Subject: ${SUBJECT_REPO}@${SUBJECT_REF}`);
  console.log(`Worker image: ${WORKER_IMAGE_DIGEST}`);
});