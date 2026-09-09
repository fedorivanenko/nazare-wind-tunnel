import {randomUUID} from 'node:crypto';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {Arm, RunSpec} from '@nazare/wind-tunnel-domain';
import {createRun, ensureSchema, getRun, listArtifacts} from '@nazare/wind-tunnel-storage';

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.WIND_TUNNEL_TOKEN ?? '';
const MAX_BODY_BYTES = 256_000;

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage) {
  return Boolean(TOKEN) && req.headers.authorization === `Bearer ${TOKEN}`;
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
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function validateArm(value: unknown): Arm {
  if (value !== 'raw' && value !== 'nazare') throw new Error('arm must be raw or nazare');
  return value;
}

await ensureSchema();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health') {
      json(res, 200, {ok:true, service:'nazare-wind-tunnel-api', version:2});
      return;
    }
    if (!authorized(req)) {
      json(res, TOKEN ? 401 : 503, {error: TOKEN ? 'unauthorized' : 'WIND_TUNNEL_TOKEN is not configured'});
      return;
    }

    if (req.method === 'POST' && url.pathname === '/runs') {
      const body = await readBody(req);
      const repository = String(body.repository ?? '');
      const sourceSha = String(body.sourceSha ?? '');
      const experiment = String(body.experiment ?? '');
      const arm = validateArm(body.arm);
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('repository must be owner/name');
      if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new Error('sourceSha must be a full commit SHA');
      if (!experiment || experiment.startsWith('/') || experiment.includes('..')) throw new Error('experiment must be a safe repo-relative path');
      const now = new Date().toISOString();
      const spec: RunSpec = {
        runId: randomUUID(),
        subject: {repository, githubSha: sourceSha},
        experiment: {path: experiment},
        arm,
        agent: {
          provider: body.provider ? String(body.provider) : null,
          model: body.model ? String(body.model) : null,
          thinking: body.thinking ? String(body.thinking) : null,
          timeoutMs: Number(body.timeoutMs ?? 15 * 60 * 1000),
        },
        createdAt: now,
      };
      const run = await createRun(spec);
      json(res, 202, {runId: run.runId, status: run.status, repository, sourceSha, experiment, arm});
      return;
    }

    const runMatch = url.pathname.match(/^\/runs\/([0-9a-f-]+)$/i);
    if (req.method === 'GET' && runMatch) {
      json(res, 200, await getRun(runMatch[1]));
      return;
    }

    const artifactMatch = url.pathname.match(/^\/runs\/([0-9a-f-]+)\/artifacts$/i);
    if (req.method === 'GET' && artifactMatch) {
      json(res, 200, {runId: artifactMatch[1], artifacts: await listArtifacts(artifactMatch[1])});
      return;
    }

    json(res, 404, {error:'not_found'});
  } catch (error) {
    json(res, 400, {error: error instanceof Error ? error.message : String(error)});
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Nazare Wind Tunnel API listening on ${PORT}`);
});
