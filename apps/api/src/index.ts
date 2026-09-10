import {randomUUID} from 'node:crypto';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {RunLifecycle, RunSpec} from '@nazare/wind-tunnel-domain';
import {createRun, ensureSchema, getRun, listArtifacts, listEvents, listRuns, requestCancel} from '@nazare/wind-tunnel-storage';

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.WIND_TUNNEL_TOKEN ?? '';
const MAX_BODY_BYTES = 256_000;
const RUN_STATES: RunLifecycle[] = ['queued','preparing','compiling','running','verifying','cancelling','completed','failed','cancelled'];
const TERMINAL = new Set<RunLifecycle>(['completed','failed','cancelled']);

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
function authorized(req: IncomingMessage) { return Boolean(TOKEN) && req.headers.authorization === `Bearer ${TOKEN}`; }
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk); bytes+=buffer.length; if(bytes>MAX_BODY_BYTES)throw new Error('Request body too large'); chunks.push(buffer); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
await ensureSchema();
createServer(async (req,res)=>{
  try {
    const url=new URL(req.url??'/',`http://${req.headers.host??'localhost'}`);
    if(url.pathname==='/health'){json(res,200,{ok:true,service:'nazare-wind-tunnel-api',version:8,agentConfigSource:'experiment'});return;}
    if(!authorized(req)){json(res,TOKEN?401:503,{error:TOKEN?'unauthorized':'WIND_TUNNEL_TOKEN is not configured'});return;}

    if(req.method==='POST'&&url.pathname==='/runs'){
      const body=await readBody(req);
      const repository=String(body.repository??''); const sourceSha=String(body.sourceSha??''); const experiment=String(body.experiment??'');
      if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw new Error('repository must be owner/name');
      if(!/^[0-9a-f]{40}$/i.test(sourceSha))throw new Error('sourceSha must be a full commit SHA');
      if(!experiment||experiment.startsWith('/')||experiment.includes('..'))throw new Error('experiment must be a safe repo-relative path');
      const now=new Date().toISOString();
      const spec:RunSpec={runId:randomUUID(),subject:{repository,githubSha:sourceSha},experiment:{path:experiment},agent:{provider:null,model:null,thinking:null,timeoutMs:0},tools:null,createdAt:now};
      const run=await createRun(spec);
      json(res,202,{runId:run.runId,status:run.status,repository,sourceSha,experiment,agentConfigSource:'experiment'});return;
    }
    if(req.method==='GET'&&url.pathname==='/runs'){
      const statusRaw=url.searchParams.get('status'); const status=statusRaw&&RUN_STATES.includes(statusRaw as RunLifecycle)?statusRaw as RunLifecycle:undefined; const limit=Number(url.searchParams.get('limit')??25);
      json(res,200,{runs:await listRuns({limit,status})});return;
    }
    if(req.method==='GET'&&url.pathname==='/status'){
      const runs=await listRuns({limit:100}); const counts=Object.fromEntries(RUN_STATES.map(s=>[s,runs.filter(r=>r.status===s).length])); const active=runs.filter(r=>!TERMINAL.has(r.status));
      const workers=active.filter(r=>r.workerId).map(r=>({runId:r.runId,workerId:r.workerId,status:r.status,leaseUntil:r.leaseUntil,healthy:Boolean(r.leaseUntil&&Date.parse(r.leaseUntil)>Date.now())}));
      json(res,200,{counts,activeRuns:active.length,queued:counts.queued??0,workers,at:new Date().toISOString()});return;
    }
    const cancelMatch=url.pathname.match(/^\/runs\/([0-9a-f-]+)\/cancel$/i);
    if(req.method==='POST'&&cancelMatch){const run=await requestCancel(cancelMatch[1]);json(res,202,{runId:run.runId,status:run.status,cancelRequestedAt:run.cancelRequestedAt});return;}
    const eventMatch=url.pathname.match(/^\/runs\/([0-9a-f-]+)\/events$/i);
    if(req.method==='GET'&&eventMatch){const after=Number(url.searchParams.get('after')??0);const limit=Number(url.searchParams.get('limit')??500);json(res,200,{runId:eventMatch[1],events:await listEvents(eventMatch[1],after,limit)});return;}
    const streamMatch=url.pathname.match(/^\/runs\/([0-9a-f-]+)\/stream$/i);
    if(req.method==='GET'&&streamMatch){
      const runId=streamMatch[1];let after=Number(url.searchParams.get('after')??0);let closed=false;req.on('close',()=>{closed=true;});
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','x-accel-buffering':'no'});res.write(`event: ready\ndata: ${JSON.stringify({runId})}\n\n`);
      while(!closed){const events=await listEvents(runId,after,250);for(const event of events){after=Math.max(after,Number(event.seq??0));res.write(`id: ${event.seq}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`);}const run=await getRun(runId);if(TERMINAL.has(run.status)){res.write(`event: terminal\ndata: ${JSON.stringify(run)}\n\n`);res.end();return;}res.write(`event: heartbeat\ndata: ${JSON.stringify({at:new Date().toISOString(),status:run.status,elapsedMs:run.elapsedMs,leaseUntil:run.leaseUntil})}\n\n`);await new Promise(resolve=>setTimeout(resolve,1_000));}return;
    }
    const runMatch=url.pathname.match(/^\/runs\/([0-9a-f-]+)$/i); if(req.method==='GET'&&runMatch){json(res,200,await getRun(runMatch[1]));return;}
    const artifactMatch=url.pathname.match(/^\/runs\/([0-9a-f-]+)\/artifacts$/i); if(req.method==='GET'&&artifactMatch){json(res,200,{runId:artifactMatch[1],artifacts:await listArtifacts(artifactMatch[1])});return;}
    json(res,404,{error:'not_found'});
  } catch(error){json(res,400,{error:error instanceof Error?error.message:String(error)});}
}).listen(PORT,'0.0.0.0',()=>{console.log(`Nazare Wind Tunnel API listening on ${PORT}`);});
