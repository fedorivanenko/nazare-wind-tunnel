import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export type PiRunOptions = {
  cwd: string;
  prompt: string;
  provider?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  extensions?: string[];
  timeoutMs: number;
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void | Promise<void>;
  onStderrLine?: (line: string) => void | Promise<void>;
  onSpawn?: (event: {pid:number; executable:string}) => void | Promise<void>;
  onFirstOutput?: (event: {pid:number; stream:'stdout'|'stderr'; afterMs:number}) => void | Promise<void>;
  onHeartbeat?: (event: {pid:number; runtimeMs:number; stdoutBytes:number; stderrBytes:number}) => void | Promise<void>;
  onSignal?: (event: {pid:number; signal:'SIGUSR2'|'SIGTERM'|'SIGKILL'; reason:'startup'|'idle'|'overall'|'abort'}) => void | Promise<void>;
  onError?: (event: {pid:number|null; error:string}) => void | Promise<void>;
  heartbeatMs?: number;
};

export type PiTimeoutReason = 'startup' | 'idle' | 'overall' | null;
export const PI_VERSION = '0.85.1';

export type ProviderProbe = {
  provider: string;
  model: string;
  ok: boolean;
  skipped: boolean;
  reachable: boolean;
  authenticated: boolean;
  modelAvailable: boolean;
  status: number | null;
  durationMs: number;
  requestId: string | null;
  error: string | null;
};

export async function probeProvider(provider:string,model:string,timeoutMs=5_000):Promise<ProviderProbe>{
  const started=Date.now();
  if(provider!=='vercel-ai-gateway')return {provider,model,ok:true,skipped:true,reachable:false,authenticated:false,modelAvailable:false,status:null,durationMs:0,requestId:null,error:null};
  const apiKey=process.env.AI_GATEWAY_API_KEY??'';
  if(!apiKey)return {provider,model,ok:false,skipped:false,reachable:false,authenticated:false,modelAvailable:false,status:null,durationMs:Date.now()-started,requestId:null,error:'AI_GATEWAY_API_KEY is missing'};
  try{
    const response=await fetch('https://ai-gateway.vercel.sh/v1/models',{headers:{authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(Math.max(1_000,timeoutMs))});
    const requestId=response.headers.get('x-request-id')??response.headers.get('x-vercel-id');
    let modelAvailable=false;
    let parseError:string|null=null;
    if(response.ok){
      try{const body=await response.json() as {data?:Array<{id?:string}>};modelAvailable=Boolean(body.data?.some(item=>item.id===model));}
      catch(error){parseError=`Invalid models response: ${error instanceof Error?error.message:String(error)}`;}
    }
    const authenticated=response.status!==401&&response.status!==403;
    return {provider,model,ok:response.ok&&modelAvailable,skipped:false,reachable:true,authenticated,modelAvailable,status:response.status,durationMs:Date.now()-started,requestId,error:response.ok?(parseError??(modelAvailable?null:`Model unavailable: ${model}`)):`Gateway returned HTTP ${response.status}`};
  }catch(error){
    const cause=error instanceof Error&&error.cause&&typeof error.cause==='object'?'code' in error.cause?String((error.cause as {code?:unknown}).code??''):null:null;
    return {provider,model,ok:false,skipped:false,reachable:false,authenticated:false,modelAvailable:false,status:null,durationMs:Date.now()-started,requestId:null,error:[error instanceof Error?error.message:String(error),cause].filter(Boolean).join(' · ')};
  }
}

export type PiSemanticEvent = {
  type: string;
  data?: Record<string, unknown>;
};

export type InspectedTool = {name:string;label:string|null;description:string|null;promptSnippet:string|null;parameters:unknown;extension:string};

export async function inspectPiExtensions(extensions:Array<{path:string;absolutePath:string;sha256:string}>):Promise<InspectedTool[]> {
  const tools:InspectedTool[]=[];
  const names=new Set<string>();
  for(const extension of extensions){
    const loaded=await import(`${pathToFileURL(extension.absolutePath).href}?sha256=${extension.sha256}`) as {default?:unknown};
    if(typeof loaded.default!=='function')throw new Error(`Pi extension must export a default registration function: ${extension.path}`);
    const api=new Proxy({registerTool:(definition:unknown)=>{
      if(!definition||typeof definition!=='object')throw new Error(`Pi extension registered an invalid tool: ${extension.path}`);
      const tool=definition as Record<string,unknown>;const name=String(tool.name??'').trim();
      if(!name)throw new Error(`Pi extension registered a tool without a name: ${extension.path}`);
      if(names.has(name))throw new Error(`Duplicate Pi tool registration: ${name}`);
      names.add(name);tools.push({name,label:typeof tool.label==='string'?tool.label:null,description:typeof tool.description==='string'?tool.description:null,promptSnippet:typeof tool.promptSnippet==='string'?tool.promptSnippet:null,parameters:tool.parameters??null,extension:extension.path});
    }},{get:(target,property)=>property in target?target[property as keyof typeof target]:()=>undefined});
    await (loaded.default as (api:unknown)=>unknown)(api);
  }
  return tools;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromContent).join('');
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.delta === 'string') return item.delta;
  if (item.content != null) return textFromContent(item.content);
  return '';
}

export function normalizePiJsonLine(line: string): PiSemanticEvent[] {
  let event: Record<string, any>;
  try {
    event = JSON.parse(line) as Record<string, any>;
  } catch {
    return [{type:'agent.output.unparsed',data:{text:line.slice(0,8_000)}}];
  }

  const type = String(event.type ?? '');
  if (type === 'session') return [{type:'agent.session',data:{sessionId:event.id,version:event.version,cwd:event.cwd}}];
  if (type === 'agent_start') return [{type:'agent.lifecycle',data:{state:'started'}}];
  if (type === 'agent_end') return [{type:'agent.lifecycle',data:{state:'ended',willRetry:event.willRetry}}];
  if (type === 'agent_settled') return [{type:'agent.lifecycle',data:{state:'settled'}}];
  if (type === 'turn_start') return [{type:'agent.turn.started'}];
  if (type === 'turn_end') return [{type:'agent.turn.completed',data:{toolResults:Array.isArray(event.toolResults)?event.toolResults.length:0,usage:event.message?.usage}}];

  if (type === 'message_start') {
    const message = event.message ?? {};
    return [{type:'agent.message.started',data:{role:message.role ?? 'assistant',provider:message.provider,model:message.model,text:textFromContent(message.content)}}];
  }

  if (type === 'message_end') {
    const message = event.message ?? {};
    return [{type:'agent.message.completed',data:{role:message.role ?? 'assistant',text:textFromContent(message.content),usage:message.usage,stopReason:message.stopReason,responseId:message.responseId}}];
  }

  if (type === 'message_update') {
    const update = event.assistantMessageEvent ?? event.delta ?? {};
    const updateType = String(update.type ?? '');
    if (updateType === 'thinking_start') return [{type:'agent.thinking.started',data:{contentIndex:update.contentIndex}}];
    if (updateType === 'thinking_delta') return [{type:'agent.thinking.delta',data:{text:String(update.delta ?? ''),contentIndex:update.contentIndex}}];
    if (updateType === 'thinking_end') return [{type:'agent.thinking.completed',data:{text:String(update.content ?? ''),contentIndex:update.contentIndex}}];
    if (updateType === 'text_start') return [{type:'agent.message.text.started',data:{contentIndex:update.contentIndex}}];
    if (updateType === 'text_delta') return [{type:'agent.message.delta',data:{role:'assistant',text:String(update.delta ?? ''),contentIndex:update.contentIndex}}];
    if (updateType === 'text_end') return [{type:'agent.message.text.completed',data:{text:String(update.content ?? ''),contentIndex:update.contentIndex}}];
    return [{type:'agent.message.update',data:{updateType,usage:event.usage}}];
  }

  if (type === 'tool_execution_start' || type === 'tool_call_start' || type === 'tool_call' || type === 'tool_use') {
    return [{type:'agent.tool.started',data:{toolCallId:event.toolCallId ?? event.tool_call_id ?? event.id,name:event.toolName ?? event.tool_name ?? event.name ?? event.tool?.name ?? 'tool',args:event.args ?? event.arguments ?? event.input ?? event.tool?.input}}];
  }
  if (type === 'tool_execution_update') {
    return [{type:'agent.tool.update',data:{name:event.toolName ?? event.tool_name ?? event.name ?? 'tool',text:textFromContent(event.output ?? event.result ?? event.content)}}];
  }
  if (type === 'tool_execution_end' || type === 'tool_call_end' || type === 'tool_result') {
    return [{type:'agent.tool.completed',data:{toolCallId:event.toolCallId ?? event.tool_call_id ?? event.id,name:event.toolName ?? event.tool_name ?? event.name ?? event.tool?.name ?? 'tool',result:textFromContent(event.result ?? event.output ?? event.content),isError:Boolean(event.isError ?? event.error)}}];
  }

  return [{type:'agent.pi',data:{piType:type || 'unknown'}}];
}

export async function runPi(options: PiRunOptions) {
  const args = ['--mode','json','--verbose','--offline','-p','--no-session','--no-approve','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files'];
  if (options.tools?.length) args.push('--tools', options.tools.join(','));
  for (const extension of options.extensions ?? []) args.push('--extension', extension);
  if (options.provider) args.push('--provider', options.provider);
  if (options.model) args.push('--model', options.model);
  if (options.thinking) args.push('--thinking', options.thinking);
  args.push('--', options.prompt);

  const piBin = process.env.WIND_TUNNEL_PI_BIN ?? 'pi';
  const started = Date.now();
  const reportDirectory=path.join(os.tmpdir(),`wind-tunnel-pi-${randomUUID()}`);
  const reportFilename='node-diagnostic-report.json';
  await mkdir(reportDirectory,{recursive:true});
  const reportOptions=`--report-on-signal --report-signal=SIGUSR2 --report-directory=${reportDirectory} --report-filename=${reportFilename}`;
  return await new Promise<{pid:number|null; exitCode:number|null; signal:NodeJS.Signals|null; stdout:string; stderr:string; stdoutBytes:number; stderrBytes:number; diagnosticReport:string|null; durationMs:number; timedOut:boolean; timeoutReason:PiTimeoutReason; aborted:boolean; firstOutputMs:number|null; lastActivityAt:string|null}>((resolve, reject) => {
    const child = spawn(piBin, args, {cwd:options.cwd,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS,reportOptions].filter(Boolean).join(' '),PI_CODING_AGENT_DIR:path.join(reportDirectory,'config'),PI_SKIP_VERSION_CHECK:'1',PI_TELEMETRY:'0'}});
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let timedOut = false;
    let timeoutReason: PiTimeoutReason = null;
    let aborted = false;
    let settled = false;
    let terminating = false;
    let firstOutputMs: number | null = null;
    let lastActivityAt: string | null = null;
    let idleTimer: NodeJS.Timeout | null = null;

    const notify = (callback: (() => void | Promise<void>) | undefined) => { if (callback) Promise.resolve(callback()).catch(() => {}); };
    const terminate = (reason: 'startup' | 'idle' | 'overall' | 'abort') => {
      if (settled||terminating) return;
      terminating=true;
      if (reason === 'abort') aborted = true;
      else {
        timedOut = true;
        timeoutReason = reason;
      }
      const pid=child.pid;
      if(pid&&reason!=='abort'){
        notify(()=>options.onSignal?.({pid,signal:'SIGUSR2',reason}));
        child.kill('SIGUSR2');
      }
      setTimeout(()=>{
        if(settled)return;
        const termPid=child.pid;
        if(termPid)notify(()=>options.onSignal?.({pid:termPid,signal:'SIGTERM',reason}));
        child.kill('SIGTERM');
        setTimeout(()=>{
          if(!settled){const killPid=child.pid;if(killPid)notify(()=>options.onSignal?.({pid:killPid,signal:'SIGKILL',reason}));child.kill('SIGKILL');}
        },2_000).unref();
      },reason==='abort'?0:100).unref();
    };

    const resetIdleTimer = () => {
      if (!options.idleTimeoutMs || options.idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => terminate('idle'), options.idleTimeoutMs);
      idleTimer.unref();
    };

    const noteActivity = (stream: 'stdout' | 'stderr') => {
      if(terminating)return;
      if (firstOutputMs == null) {
        const afterMs=Date.now()-started;
        const pid=child.pid;
        firstOutputMs=afterMs;
        if (pid) notify(() => options.onFirstOutput?.({pid,stream,afterMs}));
      }
      lastActivityAt = new Date().toISOString();
      resetIdleTimer();
    };

    const emitLines = (kind: 'stdout' | 'stderr', chunk: string) => {
      if (kind === 'stdout') stdoutBuffer += chunk;
      else stderrBuffer += chunk;
      let buffer = kind === 'stdout' ? stdoutBuffer : stderrBuffer;
      const callback = kind === 'stdout' ? options.onStdoutLine : options.onStderrLine;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0,index);
        buffer = buffer.slice(index + 1);
        if (line && callback) Promise.resolve(callback(line)).catch(() => {});
      }
      if (kind === 'stdout') stdoutBuffer = buffer;
      else stderrBuffer = buffer;
    };

    child.on('spawn', () => { const pid=child.pid;if(pid)notify(()=>options.onSpawn?.({pid,executable:piBin})); });
    child.stdout?.on('data', chunk => {
      noteActivity('stdout');
      const text = chunk.toString();
      stdoutBytes += Buffer.byteLength(text);
      stdout = (stdout + text).slice(-20_000_000);
      emitLines('stdout', text);
    });
    child.stderr?.on('data', chunk => {
      noteActivity('stderr');
      const text = chunk.toString();
      stderrBytes += Buffer.byteLength(text);
      stderr = (stderr + text).slice(-20_000_000);
      emitLines('stderr', text);
    });
    child.on('error', error => {void rm(reportDirectory,{recursive:true,force:true});notify(()=>options.onError?.({pid:child.pid??null,error:error.message}));reject(error);});

    const onAbort = () => terminate('abort');
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, {once:true});

    const overallTimer = setTimeout(() => terminate('overall'), options.timeoutMs);
    const startupTimer = options.startupTimeoutMs && options.startupTimeoutMs > 0
      ? setTimeout(() => { if (firstOutputMs == null) terminate('startup'); }, options.startupTimeoutMs)
      : null;
    overallTimer.unref();
    startupTimer?.unref();
    const heartbeat = setInterval(() => {
      const pid=child.pid;
      if(pid)notify(()=>options.onHeartbeat?.({pid,runtimeMs:Date.now()-started,stdoutBytes,stderrBytes}));
    }, Math.max(1_000,options.heartbeatMs??5_000));
    heartbeat.unref();

    child.on('close', async (exitCode, signal) => {
      settled = true;
      clearTimeout(overallTimer);
      clearInterval(heartbeat);
      if (startupTimer) clearTimeout(startupTimer);
      if (idleTimer) clearTimeout(idleTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (stdoutBuffer && options.onStdoutLine) Promise.resolve(options.onStdoutLine(stdoutBuffer)).catch(() => {});
      if (stderrBuffer && options.onStderrLine) Promise.resolve(options.onStderrLine(stderrBuffer)).catch(() => {});
      const diagnosticReport=await readFile(path.join(reportDirectory,reportFilename),'utf8').catch(()=>null);
      await rm(reportDirectory,{recursive:true,force:true}).catch(()=>{});
      resolve({pid:child.pid??null,exitCode,signal,stdout,stderr,stdoutBytes,stderrBytes,diagnosticReport,durationMs:Date.now()-started,timedOut,timeoutReason,aborted,firstOutputMs,lastActivityAt});
    });
  });
}
