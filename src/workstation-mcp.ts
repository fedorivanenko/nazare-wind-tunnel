import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {getRun, listRuns, prepareWorkspace, runTest, workspaceStatus} from './workstation-runner';

const PORT = Number(process.env.PORT ?? 3001);
const TOKEN = process.env.WIND_TUNNEL_TOKEN ?? '';

type Rpc = {jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>};

const tools = [
  {name: 'workspace_status', description: 'Inspect frozen target, prepared workspace, current environment checkout, and run storage.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}},
  {name: 'run_test', description: 'Run one fixed-budget test against an environment branch/ref. The ref is resolved to an immutable commit SHA.', inputSchema: {type: 'object', properties: {environmentRef: {type: 'string'}}, additionalProperties: false}},
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

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'workspace_status': return workspaceStatus();
    case 'run_test': return runTest(args.environmentRef ? String(args.environmentRef) : undefined);
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

await prepareWorkspace();

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/health') {
    try { return json(res, 200, {ok: true, ...(await workspaceStatus())}); }
    catch (e) { return json(res, 503, {ok: false, error: e instanceof Error ? e.message : String(e)}); }
  }
  if (url.pathname !== '/mcp') { res.statusCode = 404; return res.end(); }
  if (!authorized(req)) return json(res, TOKEN ? 401 : 503, {error: TOKEN ? 'unauthorized' : 'WIND_TUNNEL_TOKEN not configured'});
  if (req.method !== 'POST') return json(res, 405, {error: 'method_not_allowed'});

  let body: Rpc;
  try { body = JSON.parse(await readBody(req)) as Rpc; }
  catch { return json(res, 400, error(null, -32700, 'Parse error')); }

  try {
    switch (body.method) {
      case 'initialize': return json(res, 200, result(body.id, {protocolVersion: String(body.params?.protocolVersion ?? '2025-06-18'), capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'nazare-wind-tunnel', version: '3.0.0'}, instructions: 'Persistent Wind Tunnel workstation: frozen target, branch-versioned environments, fixed-budget Pi runs, deterministic verification.'}));
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
}).listen(PORT, '0.0.0.0', () => console.log(`Nazare Wind Tunnel workstation MCP listening on ${PORT}`));
