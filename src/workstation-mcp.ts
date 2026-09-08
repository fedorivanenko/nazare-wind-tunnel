import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {getRun, listRuns, prepareWorkspace, runTest, workspaceStatus} from './workstation-runner';

const PORT = Number(process.env.PORT ?? 3001);
const TOKEN = process.env.WIND_TUNNEL_TOKEN ?? '';

type Rpc = {jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>};
type PreparationState = {
  status: 'starting' | 'preparing' | 'ready' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

const preparation: PreparationState = {
  status: 'starting',
  startedAt: null,
  finishedAt: null,
  error: null,
};
let preparationPromise: Promise<void> | null = null;

const tools = [
  {name: 'workspace_status', description: 'Inspect service readiness, frozen target, prepared workspace, current environment checkout, and run storage.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}},
  {name: 'run_test', description: 'Run one fixed-budget test against an environment branch/ref. The ref is resolved to an immutable commit SHA. Requires a ready workspace.', inputSchema: {type: 'object', properties: {environmentRef: {type: 'string'}}, additionalProperties: false}},
  {name: 'get_run', description: 'Read one run summary plus small text artifacts including patch, transcript, verifier output, and metrics.', inputSchema: {type: 'object', required: ['runId'], properties: {runId: {type: 'string'}}, additionalProperties: false}},
  {name: 'get_latest_run', description: 'Read the latest run summary and artifacts.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}},
  {name: 'list_runs', description: 'List recent run summaries.', inputSchema: {type: 'object', properties: {limit: {type: 'number'}}, additionalProperties: false}},
] as const;

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}
function result(id: Rpc['id'], value: unknown) { return {jsonrpc: '2.0', id: id ?? null, result: value}; }
function error(id: Rpc['id'], code: number, message: string) { return {jsonrpc: '2.0', id: id ?? null, error: {code, message}}; }
function authorized(req: IncomingMessage) { return Boolean(TOKEN) && req.headers.authorization === `Bearer ${TOKEN}`; }

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function beginWorkspacePreparation() {
  if (preparationPromise) return preparationPromise;
  preparation.status = 'preparing';
  preparation.startedAt = new Date().toISOString();
  preparation.finishedAt = null;
  preparation.error = null;
  preparationPromise = prepareWorkspace()
    .then(() => {
      preparation.status = 'ready';
      preparation.finishedAt = new Date().toISOString();
      console.log('Wind Tunnel workspace ready');
    })
    .catch(cause => {
      preparation.status = 'failed';
      preparation.finishedAt = new Date().toISOString();
      preparation.error = cause instanceof Error ? cause.message : String(cause);
      console.error('Wind Tunnel workspace preparation failed:', preparation.error);
    });
  return preparationPromise;
}

async function serviceStatus() {
  let workspace: unknown = null;
  try { workspace = await workspaceStatus(); } catch {}
  return {ready: preparation.status === 'ready', preparation: {...preparation}, workspace};
}

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'workspace_status': return serviceStatus();
    case 'run_test': {
      if (preparation.status !== 'ready') {
        if (preparation.status === 'failed') {
          preparationPromise = null;
          void beginWorkspacePreparation();
        }
        throw new Error(`workspace_not_ready: ${preparation.status}${preparation.error ? ` (${preparation.error})` : ''}`);
      }
      return runTest(args.environmentRef ? String(args.environmentRef) : undefined);
    }
    case 'get_run': return getRun(String(args.runId ?? ''));
    case 'get_latest_run': {
      const recent = await listRuns(1);
      if (!recent.length) throw new Error('no runs yet');
      return getRun(String((recent[0] as {runId: string}).runId));
    }
    case 'list_runs': return {runs: await listRuns(Number(args.limit ?? 20))};
    default: throw new Error(`unknown tool ${name}`);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/health') return json(res, 200, {ok: true, service: 'nazare-wind-tunnel'});
  if (url.pathname === '/ready') {
    const status = await serviceStatus();
    return json(res, status.ready ? 200 : 503, status);
  }
  if (url.pathname !== '/mcp') { res.statusCode = 404; return res.end(); }
  if (!authorized(req)) return json(res, TOKEN ? 401 : 503, {error: TOKEN ? 'unauthorized' : 'WIND_TUNNEL_TOKEN not configured'});
  if (req.method !== 'POST') return json(res, 405, {error: 'method_not_allowed'});

  let body: Rpc;
  try { body = JSON.parse(await readBody(req)) as Rpc; }
  catch { return json(res, 400, error(null, -32700, 'Parse error')); }

  try {
    switch (body.method) {
      case 'initialize': return json(res, 200, result(body.id, {protocolVersion: String(body.params?.protocolVersion ?? '2025-06-18'), capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'nazare-wind-tunnel', version: '3.1.0'}, instructions: 'Persistent Wind Tunnel workstation: frozen target, branch-versioned environments, fixed-budget Pi runs, deterministic verification. Service liveness is independent from workspace readiness.'}));
      case 'notifications/initialized': res.statusCode = 202; return res.end();
      case 'ping': return json(res, 200, result(body.id, {}));
      case 'tools/list': return json(res, 200, result(body.id, {tools}));
      case 'tools/call': {
        const value = await callTool(String(body.params?.name ?? ''), (body.params?.arguments ?? {}) as Record<string, unknown>);
        const payload = {content: [{type: 'text', text: JSON.stringify(value, null, 2)}], structuredContent: value && typeof value === 'object' && !Array.isArray(value) ? value : {value}, isError: false};
        return json(res, 200, result(body.id, payload));
      }
      default: return json(res, 200, error(body.id, -32601, `Method not found: ${body.method}`));
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(res, 200, result(body.id, {content: [{type: 'text', text: message}], structuredContent: {error: message}, isError: true}));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Nazare Wind Tunnel workstation MCP listening on ${PORT}`);
  void beginWorkspacePreparation();
});
