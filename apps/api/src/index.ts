import {randomUUID} from 'node:crypto';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {Arm, RunLifecycle, RunSpec} from '@nazare/wind-tunnel-domain';
import {createRun, ensureSchema, getRun, listArtifacts, listEvents, listRuns, requestCancel} from '@nazare/wind-tunnel-storage';

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.WIND_TUNNEL_TOKEN ?? '';
const MAX_BODY_BYTES = 256_000;
const MAX_MODEL_TIMEOUT_MS = 30_000;
const RUN_STATES: RunLifecycle[] = ['queued','preparing','compiling','running','verifying','cancelling','completed','failed','cancelled'];
const TERMINAL_STATES = new Set<RunLifecycle>(['completed','failed','cancelled']);

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, body: string) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(body);
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

function dashboard() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nazare Wind Tunnel</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f1117;color:#e7e9ee;margin:0;padding:24px}main{max-width:1180px;margin:auto}h1,h2,h3{font-family:system-ui,sans-serif}h1{font-size:24px;margin:0}h2{font-size:18px;margin:0 0 12px}h3{font-size:14px;margin:18px 0 8px;color:#c7cbd6}.head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.bar{display:flex;gap:8px;align-items:center}.auth{display:flex;gap:8px;align-items:center}.auth input{width:360px}input,button{background:#181b24;color:#eee;border:1px solid #353949;border-radius:7px;padding:9px 11px}button{cursor:pointer}.danger{border-color:#743b43;color:#ff9ca5}.ghost{background:transparent}.connected{color:#71d99d}.disconnected{color:#ff8c8c}.muted,.small{color:#8d94a5}.small{font-size:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.card,.run{border:1px solid #2c3040;border-radius:10px;padding:14px;background:#151821}.runs{display:grid;gap:8px}.run{cursor:pointer}.run:hover{border-color:#4d556d}.top{display:flex;justify-content:space-between;gap:12px;align-items:center}.status{font-weight:700}.running,.preparing,.compiling,.verifying{color:#67a7ff}.completed{color:#71d99d}.failed{color:#ff7070}.cancelled,.cancelling{color:#e5b95d}.meta{color:#9ca3b5;margin-top:7px;overflow-wrap:anywhere}.events{white-space:pre-wrap;color:#c8ccd8;background:#0c0e13;border-radius:7px;padding:10px;max-height:420px;overflow:auto}.progress{height:7px;background:#2a2e3a;border-radius:4px;margin-top:8px;overflow:hidden}.progress i{display:block;height:100%;background:#67a7ff}.error{color:#ff8c8c;white-space:pre-wrap}.kv{display:grid;grid-template-columns:150px 1fr;gap:7px 14px}.phase{display:flex;justify-content:space-between;border-bottom:1px solid #272b36;padding:7px 0}.artifact{border-bottom:1px solid #272b36;padding:7px 0;overflow-wrap:anywhere}.back{margin-bottom:14px;display:inline-block;color:#a8c7ff;cursor:pointer}.empty{padding:18px;border:1px dashed #343947;border-radius:10px;color:#8d94a5}.pill{display:inline-block;border:1px solid #353949;border-radius:999px;padding:3px 7px}.worker-ok{color:#71d99d}.worker-stale{color:#ff8c8c}@media(max-width:800px){.grid{grid-template-columns:1fr}.head{align-items:flex-start;flex-direction:column}.auth{width:100%}.auth input{width:100%}.kv{grid-template-columns:110px 1fr}}
</style></head>
<body><main><div class="head"><div><h1>Nazare Wind Tunnel</h1><div id="conn" class="small">Not connected</div></div><div class="auth"><input id="token" type="password" placeholder="WIND_TUNNEL_TOKEN"><button id="save">Connect</button></div></div><div id="app"></div></main>
<script>
const app=document.getElementById('app'), conn=document.getElementById('conn'), tokenInput=document.getElementById('token');
tokenInput.value=sessionStorage.wtToken||'';
const terminal=new Set(['completed','failed','cancelled']);
const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
const auth=()=>({'Authorization':'Bearer '+(sessionStorage.wtToken||tokenInput.value)});
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{...auth(),...(opts.headers||{})}});if(!r.ok){const t=await r.text();const e=new Error(t||('HTTP '+r.status));e.status=r.status;throw e}return r.json()}
function fmtMs(ms){if(ms==null)return '—';if(ms<1000)return Math.round(ms)+' ms';return (ms/1000).toFixed(ms<10000?1:0)+' s'}
function eventTime(x){return Date.parse(x.at)}
function workerHealth(r){if(terminal.has(r.status)||!r.workerId)return {label:'—',cls:'muted'};const lease=Date.parse(r.leaseUntil||0);return lease>Date.now()?{label:'healthy',cls:'worker-ok'}:{label:'stale',cls:'worker-stale'}}
function phaseDurations(r,events){const first=t=>events.find(e=>e.type===t);const time=t=>{const e=first(t);return e?eventTime(e):null};const now=Date.now();const end=terminal.has(r.status)?Date.parse(r.finishedAt||r.updatedAt):now;const prep=time('subject.preparing');const ready=time('subject.ready');const compileStart=time('nazare.compile.started');const compileEnd=time('nazare.compile.completed');const agentStart=time('agent.started');const agentEnd=time('agent.completed')||time('agent.timeout')||time('agent.cancelled');const verifyStart=time('verification.started');const verifyEnd=time('verification.completed');return [{name:'prepare',ms:prep?(ready||end)-prep:null},{name:'compile',ms:compileStart?(compileEnd||end)-compileStart:null},{name:'agent',ms:agentStart?(agentEnd||end)-agentStart:null},{name:'verify',ms:verifyStart?(verifyEnd||end)-verifyStart:null}]}
function agentBudget(r,events){const e=events.find(x=>x.type==='agent.started');if(!e)return null;const started=eventTime(e);const ended=events.find(x=>['agent.completed','agent.timeout','agent.cancelled'].includes(x.type));const elapsed=(ended?eventTime(ended):Date.now())-started;const budget=r.spec.agent.timeoutMs||30000;return {elapsed,budget,pct:Math.min(100,Math.max(0,elapsed/budget*100)),remaining:Math.max(0,budget-elapsed)}}
function eventLine(e){let detail='';if(e.data?.text)detail='  '+String(e.data.text).replace(/\s+/g,' ').slice(0,300);else if(e.data && Object.keys(e.data).length)detail='  '+JSON.stringify(e.data).slice(0,300);return new Date(e.at).toLocaleTimeString()+'  '+e.type+detail}
async function connect(){sessionStorage.wtToken=tokenInput.value.trim();if(!sessionStorage.wtToken){conn.className='disconnected small';conn.textContent='Token required';return}try{const d=await api('/runs?limit=1');conn.className='connected small';conn.textContent='Connected ✓ · '+d.runs.length+(d.runs.length===1?' recent run':' recent runs visible');route()}catch(e){conn.className='disconnected small';conn.textContent=e.status===401?'Unauthorized — token does not match Railway':'Connection failed — '+e.message}}
document.getElementById('save').onclick=connect;tokenInput.addEventListener('keydown',e=>{if(e.key==='Enter')connect()});
async function cancelRun(id){if(!confirm('Cancel Wind Tunnel run '+id+'?'))return;await api('/runs/'+id+'/cancel',{method:'POST'});showRun(id)}
function goRun(id){history.pushState({},'', '/wind-tunnel/runs/'+id);route()}
function goHome(){history.pushState({},'', '/wind-tunnel');route()}
window.addEventListener('popstate',route);
async function showRuns(){const d=await api('/runs?limit=30');if(!d.runs.length){app.innerHTML='<div class="empty">Connected ✓ · No runs yet</div>';return}const rows=d.runs.map(r=>{const wh=workerHealth(r);return '<div class="run" onclick="goRun(\''+r.runId+'\')"><div class="top"><div><span class="status '+esc(r.status)+'">'+esc(r.status)+'</span> <span class="small">'+esc(r.runId)+'</span></div><div>'+fmtMs(r.elapsedMs)+'</div></div><div class="meta">'+esc(r.spec.subject.repository)+' @ '+esc(r.spec.subject.githubSha.slice(0,10))+' · '+esc(r.spec.arm)+' · '+esc(r.spec.experiment.path)+'</div><div class="small" style="margin-top:7px">worker: <span class="'+wh.cls+'">'+wh.label+'</span>'+ (r.errorCode?' · '+esc(r.errorCode):'') +'</div></div>'}).join('');app.innerHTML='<h2>Recent runs</h2><div class="runs">'+rows+'</div>'}
async function showRun(id){const [r,e,a]=await Promise.all([api('/runs/'+id),api('/runs/'+id+'/events?limit=500'),api('/runs/'+id+'/artifacts')]);const wh=workerHealth(r), phases=phaseDurations(r,e.events), budget=agentBudget(r,e.events);const phaseHtml=phases.map(p=>'<div class="phase"><span>'+p.name+'</span><b>'+fmtMs(p.ms)+'</b></div>').join('');const eventsHtml=e.events.length?e.events.map(eventLine).join('\n'):'No events yet';const arts=a.artifacts.length?a.artifacts.map(x=>'<div class="artifact"><b>'+esc(x.type)+'</b><div class="small">'+esc(x.key)+' · '+esc(x.mediaType)+' · '+x.bytes+' bytes</div></div>').join(''):'<div class="muted">No artifacts yet</div>';app.innerHTML='<span class="back" onclick="goHome()">← recent runs</span><div class="card"><div class="top"><div><span class="status '+esc(r.status)+'">'+esc(r.status)+'</span> <span class="small">'+esc(r.runId)+'</span></div><div>'+fmtMs(r.elapsedMs)+'</div></div><div class="meta">'+esc(r.spec.subject.repository)+' @ '+esc(r.spec.subject.githubSha)+'<br>'+esc(r.spec.arm)+' · '+esc(r.spec.experiment.path)+'</div>'+(budget?'<h3>Model budget</h3><div class="top"><span>'+fmtMs(budget.elapsed)+' / '+fmtMs(budget.budget)+'</span><span>'+fmtMs(budget.remaining)+' remaining</span></div><div class="progress"><i style="width:'+budget.pct+'%"></i></div>':'')+(r.error?'<h3>Error</h3><div class="error"><b>'+esc(r.errorCode||'error')+'</b>\n'+esc(r.error)+'</div>':'')+(!terminal.has(r.status)?'<div style="margin-top:14px"><button class="danger" onclick="cancelRun(\''+r.runId+'\')">Cancel run</button></div>':'')+'</div><div class="grid" style="margin-top:12px"><div class="card"><h2>Run</h2><div class="kv"><span class="muted">worker</span><span>'+esc(r.workerId||'—')+'</span><span class="muted">worker health</span><span class="'+wh.cls+'">'+wh.label+'</span><span class="muted">lease until</span><span>'+esc(r.leaseUntil||'—')+'</span><span class="muted">attempts</span><span>'+esc(r.attempts)+'</span><span class="muted">model timeout</span><span>'+fmtMs(r.spec.agent.timeoutMs)+'</span></div><h3>Phase timings</h3>'+phaseHtml+'</div><div class="card"><h2>Artifacts</h2>'+arts+'</div></div><div class="card" style="margin-top:12px"><h2>Timeline</h2><div class="events">'+esc(eventsHtml)+'</div></div>';if(!terminal.has(r.status)){clearTimeout(window.__wtTimer);window.__wtTimer=setTimeout(()=>showRun(id).catch(renderError),1000)}}
function renderError(e){if(e.status===401){conn.className='disconnected small';conn.textContent='Unauthorized — token does not match Railway'}app.innerHTML='<div class="error">'+esc(e.message)+'</div>'}
async function route(){clearTimeout(window.__wtTimer);if(!sessionStorage.wtToken){app.innerHTML='<div class="empty">Enter WIND_TUNNEL_TOKEN and click Connect.</div>';return}try{const m=location.pathname.match(/^\/wind-tunnel\/runs\/([0-9a-f-]+)$/i);if(m)await showRun(m[1]);else{await showRuns();window.__wtTimer=setTimeout(()=>showRuns().catch(renderError),2000)}}catch(e){renderError(e)}}
if(sessionStorage.wtToken)connect();else route();
</script></body></html>`;
}

await ensureSchema();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health') {
      json(res, 200, {ok:true, service:'nazare-wind-tunnel-api', version:4, maxModelTimeoutMs:MAX_MODEL_TIMEOUT_MS});
      return;
    }
    if (url.pathname === '/' || url.pathname === '/wind-tunnel' || /^\/wind-tunnel\/runs\/[0-9a-f-]+$/i.test(url.pathname)) {
      html(res, dashboard());
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
      const requestedTimeout = Number(body.timeoutMs ?? MAX_MODEL_TIMEOUT_MS);
      const spec: RunSpec = {
        runId: randomUUID(),
        subject: {repository, githubSha: sourceSha},
        experiment: {path: experiment},
        arm,
        agent: {
          provider: body.provider ? String(body.provider) : null,
          model: body.model ? String(body.model) : null,
          thinking: body.thinking ? String(body.thinking) : null,
          timeoutMs: Math.min(MAX_MODEL_TIMEOUT_MS, Math.max(1_000, requestedTimeout)),
        },
        createdAt: now,
      };
      const run = await createRun(spec);
      json(res, 202, {runId: run.runId, status: run.status, repository, sourceSha, experiment, arm, modelTimeoutMs:spec.agent.timeoutMs});
      return;
    }

    if (req.method === 'GET' && url.pathname === '/runs') {
      const statusRaw = url.searchParams.get('status');
      const status = statusRaw && RUN_STATES.includes(statusRaw as RunLifecycle) ? statusRaw as RunLifecycle : undefined;
      const limit = Number(url.searchParams.get('limit') ?? 25);
      json(res, 200, {runs: await listRuns({limit,status})});
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      const runs = await listRuns({limit:100});
      const counts = Object.fromEntries(RUN_STATES.map(status => [status, runs.filter(run => run.status === status).length]));
      const active = runs.filter(run => !TERMINAL_STATES.has(run.status));
      const workers = active.filter(run => run.workerId).map(run => ({runId:run.runId,workerId:run.workerId,status:run.status,leaseUntil:run.leaseUntil,healthy:Boolean(run.leaseUntil && Date.parse(run.leaseUntil) > Date.now())}));
      json(res, 200, {counts,activeRuns:active.length,workers});
      return;
    }

    const cancelMatch = url.pathname.match(/^\/runs\/([0-9a-f-]+)\/cancel$/i);
    if (req.method === 'POST' && cancelMatch) {
      const run = await requestCancel(cancelMatch[1]);
      json(res, 202, {runId:run.runId,status:run.status,cancelRequestedAt:run.cancelRequestedAt});
      return;
    }

    const eventMatch = url.pathname.match(/^\/runs\/([0-9a-f-]+)\/events$/i);
    if (req.method === 'GET' && eventMatch) {
      const after = Number(url.searchParams.get('after') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 500);
      json(res, 200, {runId:eventMatch[1],events:await listEvents(eventMatch[1],after,limit)});
      return;
    }

    const streamMatch = url.pathname.match(/^\/runs\/([0-9a-f-]+)\/stream$/i);
    if (req.method === 'GET' && streamMatch) {
      const runId = streamMatch[1];
      let after = Number(url.searchParams.get('after') ?? 0);
      let closed = false;
      req.on('close', () => { closed = true; });
      res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
      res.write(`event: ready\ndata: ${JSON.stringify({runId})}\n\n`);
      while (!closed) {
        const events = await listEvents(runId, after, 250);
        for (const event of events) {
          after = Math.max(after, Number(event.seq ?? 0));
          res.write(`id: ${event.seq}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`);
        }
        const run = await getRun(runId);
        if (TERMINAL_STATES.has(run.status)) {
          res.write(`event: terminal\ndata: ${JSON.stringify(run)}\n\n`);
          res.end();
          return;
        }
        res.write(`event: heartbeat\ndata: ${JSON.stringify({at:new Date().toISOString(),status:run.status,elapsedMs:run.elapsedMs,leaseUntil:run.leaseUntil})}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
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
