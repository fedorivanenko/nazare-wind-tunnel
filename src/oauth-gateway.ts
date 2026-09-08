import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 3000);
const INTERNAL_PORT = Number(process.env.WIND_TUNNEL_INTERNAL_PORT ?? 3001);
const ROOT_DIR = process.env.WIND_TUNNEL_ROOT ?? '/workspace';
const OAUTH_STATE_FILE = path.join(ROOT_DIR, 'oauth-state.json');
const ADMIN_SECRET = process.env.WIND_TUNNEL_TOKEN ?? '';
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
const BASE_URL = process.env.WIND_TUNNEL_PUBLIC_URL ?? (PUBLIC_DOMAIN ? `https://${PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);
const MCP_URL = `${BASE_URL}/mcp`;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 10 * 60;
const MAX_BODY_BYTES = 1_000_000;

if (!ADMIN_SECRET) throw new Error('WIND_TUNNEL_TOKEN is required');

type Client = {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  application_type?: string;
  created_at: number;
};

type AuthorizationCode = {
  hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  expires_at: number;
};

type AccessGrant = {
  hash: string;
  client_id: string;
  scope: string;
  expires_at: number;
};

type RefreshGrant = {
  hash: string;
  client_id: string;
  scope: string;
  expires_at: number;
};

type OAuthState = {
  clients: Client[];
  codes: AuthorizationCode[];
  access: AccessGrant[];
  refresh: RefreshGrant[];
};

let state: OAuthState = {clients: [], codes: [], access: [], refresh: []};
let persistChain = Promise.resolve();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}

function opaqueToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function secureEqual(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function cleanup() {
  const now = nowSeconds();
  state.codes = state.codes.filter(item => item.expires_at > now);
  state.access = state.access.filter(item => item.expires_at > now);
  state.refresh = state.refresh.filter(item => item.expires_at > now);
}

async function loadState() {
  await mkdir(ROOT_DIR, {recursive: true});
  try {
    const parsed = JSON.parse(await readFile(OAUTH_STATE_FILE, 'utf8')) as Partial<OAuthState>;
    state = {
      clients: Array.isArray(parsed.clients) ? parsed.clients : [],
      codes: Array.isArray(parsed.codes) ? parsed.codes : [],
      access: Array.isArray(parsed.access) ? parsed.access : [],
      refresh: Array.isArray(parsed.refresh) ? parsed.refresh : [],
    };
    cleanup();
  } catch {
    state = {clients: [], codes: [], access: [], refresh: []};
  }
}

function persist() {
  cleanup();
  const snapshot = JSON.stringify(state, null, 2);
  persistChain = persistChain.then(() => writeFile(OAUTH_STATE_FILE, snapshot, 'utf8')).catch(error => {
    console.error('Failed to persist OAuth state', error);
  });
  return persistChain;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > MAX_BODY_BYTES) throw new Error('request too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readForm(req: IncomingMessage) {
  return new URLSearchParams(await readBody(req));
}

function authMetadata() {
  return {
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['wind_tunnel', 'offline_access'],
    authorization_response_iss_parameter_supported: true,
  };
}

function resourceMetadata() {
  return {
    resource: MCP_URL,
    authorization_servers: [BASE_URL],
    scopes_supported: ['wind_tunnel', 'offline_access'],
    bearer_methods_supported: ['header'],
  };
}

function findClient(clientId: string) {
  return state.clients.find(client => client.client_id === clientId);
}

function validRedirect(client: Client, redirectUri: string) {
  return client.redirect_uris.includes(redirectUri);
}

function authorizePage(params: URLSearchParams, error = '') {
  const hidden = [...params.entries()]
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nazare Wind Tunnel</title><style>body{font:16px system-ui;margin:0;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh}main{width:min(460px,90vw);padding:28px;border:1px solid #333;border-radius:16px;background:#181818}h1{font-size:22px}p{color:#aaa}input[type=password]{width:100%;box-sizing:border-box;padding:12px;margin:12px 0;border-radius:8px;border:1px solid #444;background:#0e0e0e;color:#fff}button{padding:11px 16px;border:0;border-radius:8px;font-weight:650}small{color:#e88}</style></head><body><main><h1>Authorize Nazare Wind Tunnel</h1><p>Grant ChatGPT access to the private writable benchmark environment.</p>${error ? `<small>${escapeHtml(error)}</small>` : ''}<form method="post" action="/authorize">${hidden}<label>Wind-tunnel admin secret</label><input type="password" name="admin_secret" autocomplete="current-password" required><button type="submit">Authorize</button></form></main></body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch] ?? ch));
}

function validateAuthorize(params: URLSearchParams) {
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const responseType = params.get('response_type') ?? '';
  const challenge = params.get('code_challenge') ?? '';
  const challengeMethod = params.get('code_challenge_method') ?? '';
  const client = findClient(clientId);
  if (!client) return {error: 'unknown client_id'};
  if (!validRedirect(client, redirectUri)) return {error: 'invalid redirect_uri'};
  if (responseType !== 'code') return {error: 'response_type must be code'};
  if (!challenge || challengeMethod !== 'S256') return {error: 'PKCE S256 is required'};
  return {client, clientId, redirectUri, challenge};
}

async function handleRegister(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, {error: 'method_not_allowed'});
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readBody(req));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_client_metadata');
    body = parsed as Record<string, unknown>;
  } catch {
    return json(res, 400, {error: 'invalid_client_metadata'});
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (!redirectUris.length) return json(res, 400, {error: 'invalid_redirect_uri'});
  for (const uri of redirectUris) {
    try { new URL(uri); } catch { return json(res, 400, {error: 'invalid_redirect_uri'}); }
  }
  const client: Client = {
    client_id: `nazare_${opaqueToken(18)}`,
    client_name: typeof body.client_name === 'string' ? body.client_name : 'MCP client',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: typeof body.application_type === 'string' ? body.application_type : 'web',
    created_at: nowSeconds(),
  };
  state.clients.push(client);
  await persist();
  json(res, 201, client);
}

async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === 'GET') {
    const check = validateAuthorize(url.searchParams);
    if ('error' in check) return html(res, 400, authorizePage(url.searchParams, check.error));
    return html(res, 200, authorizePage(url.searchParams));
  }
  if (req.method !== 'POST') return json(res, 405, {error: 'method_not_allowed'});
  const params = await readForm(req);
  const adminSecret = params.get('admin_secret') ?? '';
  params.delete('admin_secret');
  const check = validateAuthorize(params);
  if ('error' in check) return html(res, 400, authorizePage(params, check.error));
  if (!secureEqual(adminSecret, ADMIN_SECRET)) return html(res, 401, authorizePage(params, 'Invalid secret'));

  const code = opaqueToken();
  state.codes.push({
    hash: sha256(code),
    client_id: check.clientId,
    redirect_uri: check.redirectUri,
    code_challenge: check.challenge,
    scope: normalizeScope(params.get('scope')),
    expires_at: nowSeconds() + CODE_TTL_SECONDS,
  });
  await persist();

  const redirect = new URL(check.redirectUri);
  redirect.searchParams.set('code', code);
  const stateParam = params.get('state');
  if (stateParam) redirect.searchParams.set('state', stateParam);
  redirect.searchParams.set('iss', BASE_URL);
  res.statusCode = 302;
  res.setHeader('location', redirect.toString());
  res.end();
}

function normalizeScope(scope: string | null) {
  const requested = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  requested.add('wind_tunnel');
  requested.add('offline_access');
  return [...requested].join(' ');
}

function issueTokens(clientId: string, scope: string) {
  const accessToken = opaqueToken();
  const refreshToken = opaqueToken(48);
  const now = nowSeconds();
  state.access.push({hash: sha256(accessToken), client_id: clientId, scope, expires_at: now + ACCESS_TTL_SECONDS});
  state.refresh.push({hash: sha256(refreshToken), client_id: clientId, scope, expires_at: now + REFRESH_TTL_SECONDS});
  return {accessToken, refreshToken};
}

async function handleToken(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 405, {error: 'method_not_allowed'});
  const params = await readForm(req);
  const grantType = params.get('grant_type') ?? '';
  const clientId = params.get('client_id') ?? '';
  const client = findClient(clientId);
  if (!client) return json(res, 400, {error: 'invalid_client'});
  cleanup();

  if (grantType === 'authorization_code') {
    const code = params.get('code') ?? '';
    const verifier = params.get('code_verifier') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const codeHash = sha256(code);
    const index = state.codes.findIndex(item => secureEqual(item.hash, codeHash));
    if (index < 0) return json(res, 400, {error: 'invalid_grant'});
    const grant = state.codes[index];
    state.codes.splice(index, 1);
    if (grant.client_id !== clientId || grant.redirect_uri !== redirectUri || !verifier || sha256(verifier) !== grant.code_challenge) {
      await persist();
      return json(res, 400, {error: 'invalid_grant'});
    }
    const tokens = issueTokens(clientId, grant.scope);
    await persist();
    return json(res, 200, {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: tokens.refreshToken,
      scope: grant.scope,
    });
  }

  if (grantType === 'refresh_token') {
    const refreshToken = params.get('refresh_token') ?? '';
    const refreshHash = sha256(refreshToken);
    const index = state.refresh.findIndex(item => secureEqual(item.hash, refreshHash));
    if (index < 0) return json(res, 400, {error: 'invalid_grant'});
    const grant = state.refresh[index];
    state.refresh.splice(index, 1);
    if (grant.client_id !== clientId) {
      await persist();
      return json(res, 400, {error: 'invalid_grant'});
    }
    const tokens = issueTokens(clientId, grant.scope);
    await persist();
    return json(res, 200, {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: tokens.refreshToken,
      scope: grant.scope,
    });
  }

  json(res, 400, {error: 'unsupported_grant_type'});
}

function validateAccess(req: IncomingMessage) {
  cleanup();
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return false;
  const hash = sha256(token);
  return state.access.some(grant => grant.expires_at > nowSeconds() && secureEqual(grant.hash, hash));
}

async function proxyMcp(req: IncomingMessage, res: ServerResponse) {
  if (!validateAccess(req)) {
    res.statusCode = 401;
    res.setHeader('www-authenticate', `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp", scope="wind_tunnel offline_access"`);
    res.end('unauthorized');
    return;
  }
  const body = req.method === 'POST' ? await readBody(req) : '';
  const upstream = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/mcp`, {
    method: req.method ?? 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_SECRET}`,
      'content-type': req.headers['content-type'] ?? 'application/json',
      accept: req.headers.accept ?? 'application/json, text/event-stream',
    },
    body: body || undefined,
  });
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    if (!['content-length', 'content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) res.setHeader(key, value);
  });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

async function proxyHealth(res: ServerResponse) {
  try {
    const upstream = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/health`);
    const body = await upstream.text();
    json(res, upstream.status, {oauth: true, upstream: JSON.parse(body)});
  } catch (error) {
    json(res, 503, {oauth: true, upstream: false, error: String(error)});
  }
}

await loadState();

const child = spawn('npx', ['tsx', 'src/control.ts'], {
  cwd: process.cwd(),
  env: {...process.env, PORT: String(INTERNAL_PORT)},
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  console.error(`Internal Wind Tunnel MCP exited code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', BASE_URL);
    if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, authMetadata(), {'access-control-allow-origin': '*'});
    }
    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(res, 200, resourceMetadata(), {'access-control-allow-origin': '*'});
    }
    if (url.pathname === '/register') return await handleRegister(req, res);
    if (url.pathname === '/authorize') return await handleAuthorize(req, res, url);
    if (url.pathname === '/token') return await handleToken(req, res);
    if (url.pathname === '/mcp') return await proxyMcp(req, res);
    if (url.pathname === '/health') return await proxyHealth(res);
    json(res, 404, {error: 'not_found'});
  } catch (error) {
    console.error(error);
    json(res, 500, {error: 'server_error'});
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Nazare OAuth gateway listening on :${PORT}`);
  console.log(`Issuer: ${BASE_URL}`);
  console.log(`Protected resource: ${MCP_URL}`);
  console.log(`Internal MCP: 127.0.0.1:${INTERNAL_PORT}`);
});
