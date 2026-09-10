import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import type {ExperimentDefinition, RunState, ToolConfig, VerificationSpec} from '@nazare/wind-tunnel-domain';
import {MAX_AGENT_TIMEOUT_MS, normalizeVerification, resolveExperimentAgent, resolveExperimentTools, validateExperimentDefinition} from '@nazare/wind-tunnel-domain';
import {appendEvent, claimNextRun, ensureSchema, isCancellationRequested, putArtifact, renewLease, saveRun} from '@nazare/wind-tunnel-storage';
import {cleanSubject, ensureDependencies, ensureSubject, getSubjectPath, inspectSubjectReadiness, runSubjectProcess, type SubjectProcessObserver} from '@nazare/wind-tunnel-subject-manager';
import {inspectPiExtensions, normalizePiJsonLine, PI_VERSION, probeProvider, runPi, type PiTimeoutReason} from '@nazare/wind-tunnel-pi';

const WORKER_ID=process.env.WIND_TUNNEL_WORKER_ID??`${process.env.RAILWAY_SERVICE_NAME??'worker'}:${process.pid}:${randomUUID().slice(0,8)}`;
const POLL_MS=Number(process.env.WIND_TUNNEL_POLL_MS??2_000);
const HEARTBEAT_MS=Number(process.env.WIND_TUNNEL_HEARTBEAT_MS??5_000);
const AGENT_STARTUP_TIMEOUT_MS=Number(process.env.WIND_TUNNEL_AGENT_STARTUP_TIMEOUT_MS??15_000);
const AGENT_IDLE_TIMEOUT_MS=Number(process.env.WIND_TUNNEL_AGENT_IDLE_TIMEOUT_MS??60_000);
const PROVIDER_PROBE_TIMEOUT_MS=Number(process.env.WIND_TUNNEL_PROVIDER_PROBE_TIMEOUT_MS??5_000);
const CANCEL_POLL_MS=750;

class RunCancelledError extends Error{constructor(){super('Run cancelled');this.name='RunCancelledError';}}
class AgentTimeoutError extends Error{constructor(reason:PiTimeoutReason,timeoutMs:number){super(`Pi timed out (${reason??'unknown'}); overall budget ${timeoutMs}ms, startup ${AGENT_STARTUP_TIMEOUT_MS}ms, idle ${AGENT_IDLE_TIMEOUT_MS}ms`);this.name='AgentTimeoutError';}}
class PreflightError extends Error{constructor(failures:string[]){super(`Subject preflight failed: ${failures.join('; ')}`);this.name='PreflightError';}}
class ProviderPreflightError extends Error{constructor(message:string){super(`Provider preflight failed: ${message}`);this.name='ProviderPreflightError';}}
class BootstrapError extends Error{constructor(message:string){super(`Bootstrap failed: ${message}`);this.name='BootstrapError';}}
class ExperimentConfigError extends Error{constructor(failures:string[]){super(`Experiment configuration invalid: ${failures.join('; ')}`);this.name='ExperimentConfigError';}}

function logWorkerEvent(runId:string|null,event:string,data:Record<string,unknown>={}){
  console.log(JSON.stringify({at:new Date().toISOString(),service:'wind-tunnel-worker',workerId:WORKER_ID,runId,event,...data}));
}

function buildPrompt(task:string,bootstrapContext:Array<{id:string;result:unknown}>){
  const context=bootstrapContext.length?JSON.stringify(bootstrapContext,null,2):'No deterministic bootstrap context was configured.';
  return [
    'Complete the requested repository change within the fixed execution budget.',
    'Use the pinned bootstrap context first.',
    'Use native tool calls only; never print tool-call syntax as assistant text.',
    'Read only files identified by context unless evidence requires expansion.',
    'Prioritize producing the correct patch. Evaluator runs the full verification gate after you finish; run only targeted checks if time remains.',
    'Do not weaken tests, lint rules, policies, evidence contracts, or architectural constraints.',
    'Leave the working checkout with the implementation applied and finish immediately when the patch is complete.',
    '',
    'PINNED BOOTSTRAP CONTEXT:',context,'','TASK:',task.trim(),'','FINAL EXECUTION PRIORITY:','Do not run the full lint, test, typecheck, or build gate. Evaluator runs it after you return. Once implementation is applied, return immediately.',
  ].join('\n');
}
const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function safeSubjectPath(cwd:string,relativePath:string,label:string){
  const absolutePath=path.resolve(cwd,relativePath);
  if(!absolutePath.startsWith(`${path.resolve(cwd)}${path.sep}`))throw new ExperimentConfigError([`${label} must stay inside subject repository: ${relativePath}`]);
  return absolutePath;
}
async function resolveToolEnvironment(cwd:string,config:ToolConfig){
  const extensions=[];
  for(const relativePath of config.extensions){
    const absolutePath=safeSubjectPath(cwd,relativePath,'tool extension');
    const content=await readFile(absolutePath);
    extensions.push({path:relativePath,absolutePath,sha256:sha256(content)});
  }
  const bootstrap=[];
  for(const item of config.bootstrap){
    const absolutePath=safeSubjectPath(cwd,item.entrypoint,'bootstrap entrypoint');
    bootstrap.push({...item,absolutePath,sha256:sha256(await readFile(absolutePath))});
  }
  return {allow:config.allow,extensions,bootstrap};
}
async function assertNotCancelled(runId:string){if(await isCancellationRequested(runId))throw new RunCancelledError();}
async function verify(cwd:string,checks:VerificationSpec[],runId:string,observer?:SubjectProcessObserver){
  const results=[];let stdout='';let stderr='';
  for(const check of checks){
    await assertNotCancelled(runId);
    await appendEvent({runId,type:'verification.check.started',at:new Date().toISOString(),data:{id:check.id,command:check.command}});
    const result=await runSubjectProcess('/bin/sh',['-lc',check.command],cwd,check.timeoutMs,observer);
    stdout+=`\n$ ${check.command}\n${result.stdout}`;stderr+=`\n$ ${check.command}\n${result.stderr}`;
    const item={id:check.id,command:check.command,required:check.required,passed:result.exitCode===0&&!result.timedOut,exitCode:result.exitCode,timedOut:result.timedOut,durationMs:result.durationMs};
    results.push(item);await appendEvent({runId,type:'verification.check.completed',at:new Date().toISOString(),data:item});
  }
  return {results,stdout,stderr};
}
async function runBootstrap(input:{cwd:string;repository:string;sourceSha:string;task:string;runId:string;entries:Array<{id:string;entrypoint:string;absolutePath:string;sha256:string;timeoutMs:number;maxOutputBytes:number;required:boolean}>;observer?:SubjectProcessObserver}){
  const contexts:Array<{id:string;result:unknown}>=[];
  for(const entry of input.entries){
    const startedAt=new Date().toISOString();
    await appendEvent({runId:input.runId,type:'bootstrap.started',at:startedAt,data:{id:entry.id,entrypoint:entry.entrypoint,sha256:entry.sha256,timeoutMs:entry.timeoutMs,maxOutputBytes:entry.maxOutputBytes}});
    const payload=JSON.stringify({task:input.task,repository:input.repository,sourceSha:input.sourceSha});
    const result=await runSubjectProcess('pnpm',['exec','tsx',entry.absolutePath],input.cwd,entry.timeoutMs,input.observer,payload).catch(error=>({exitCode:null,stdout:'',stderr:error instanceof Error?error.message:String(error),stdoutBytes:0,stderrBytes:0,durationMs:0,timedOut:false}));
    const failure=result.timedOut?`timed out after ${entry.timeoutMs}ms`:result.exitCode!==0?result.stderr||result.stdout||`exit ${result.exitCode}`:result.stdoutBytes>entry.maxOutputBytes?`output exceeded ${entry.maxOutputBytes} bytes`:null;
    if(failure){
      await appendEvent({runId:input.runId,type:'bootstrap.failed',at:new Date().toISOString(),data:{id:entry.id,durationMs:result.durationMs,required:entry.required,error:failure.slice(0,2_000)}});
      await putArtifact({runId:input.runId,type:'bootstrap.stderr',name:`${entry.id}.stderr.log`,mediaType:'text/plain',content:result.stderr});
      if(entry.required)throw new BootstrapError(`${entry.id}: ${failure}`);
      continue;
    }
    let parsed:unknown;
    try{parsed=JSON.parse(result.stdout);}catch(error){
      const failure=`invalid JSON output: ${error instanceof Error?error.message:String(error)}`;
      await appendEvent({runId:input.runId,type:'bootstrap.failed',at:new Date().toISOString(),data:{id:entry.id,durationMs:result.durationMs,required:entry.required,error:failure}});
      if(entry.required)throw new BootstrapError(`${entry.id}: ${failure}`);
      continue;
    }
    contexts.push({id:entry.id,result:parsed});
    await putArtifact({runId:input.runId,type:'bootstrap.context',name:`${entry.id}.json`,mediaType:'application/json',content:JSON.stringify(parsed,null,2)});
    await appendEvent({runId:input.runId,type:'bootstrap.completed',at:new Date().toISOString(),data:{id:entry.id,durationMs:result.durationMs,outputBytes:result.stdoutBytes,inputSha256:sha256(payload),outputSha256:sha256(result.stdout)}});
  }
  return contexts;
}

async function captureWorkingTree(cwd:string,sourceSha:string,runId:string,partial:boolean,observer?:SubjectProcessObserver){
  const intent=await runSubjectProcess('git',['add','--intent-to-add','--all'],cwd,60_000,observer);
  if(intent.exitCode!==0||intent.timedOut)throw new Error(`Could not enumerate workspace changes: ${intent.stderr}`);
  const patch=await runSubjectProcess('git',['diff','--no-ext-diff','--binary',sourceSha,'--','.'],cwd,60_000,observer);
  const changed=await runSubjectProcess('git',['diff','--name-only',sourceSha,'--','.'],cwd,60_000,observer);
  if(patch.exitCode!==0||patch.timedOut||changed.exitCode!==0||changed.timedOut)throw new Error(`Could not capture workspace changes: ${patch.stderr||changed.stderr}`);
  const files=changed.stdout.split('\n').map(file=>file.trim()).filter(Boolean);
  await Promise.all([
    putArtifact({runId,type:'git.patch',name:'patch.diff',mediaType:'text/x-diff',content:patch.stdout}),
    putArtifact({runId,type:'git.changed-files',name:'changed-files.txt',mediaType:'text/plain',content:changed.stdout}),
  ]);
  await appendEvent({runId,type:'workspace.captured',at:new Date().toISOString(),data:{partial,files,changedFiles:files.length,patchBytes:Buffer.byteLength(patch.stdout)}});
}

async function executeRun(claimed:RunState){
  let state=claimed;
  let eventWrites=Promise.resolve();
  let workspaceCaptured=false;
  const enqueueEvent=(type:string,data?:Record<string,unknown>,log=false,at=new Date().toISOString())=>{
    if(log)logWorkerEvent(state.runId,type,data);
    eventWrites=eventWrites.then(()=>appendEvent({runId:state.runId,type,at,data})).then(()=>undefined).catch(error=>console.error('event write failed',error));
  };
  const observedEvent=async(type:string,data:Record<string,unknown>={})=>{logWorkerEvent(state.runId,type,data);await appendEvent({runId:state.runId,type,at:new Date().toISOString(),data});};
  const deltaBatches=new Map<string,{type:string;data:Record<string,unknown>;text:string;at:string}>();
  let deltaTimer:NodeJS.Timeout|null=null;
  const flushDeltas=()=>{
    if(deltaTimer){clearTimeout(deltaTimer);deltaTimer=null;}
    for(const batch of deltaBatches.values())enqueueEvent(batch.type,{...batch.data,text:batch.text},false,batch.at);
    deltaBatches.clear();
  };
  const toolStarts=new Map<string,number>();
  let assistantSyntaxTail='';let malformedToolSyntaxObserved=false;
  const enqueueSemanticEvent=(type:string,data:Record<string,unknown>={})=>{
    if(type==='agent.message.update'||type==='agent.pi'||type==='agent.tool.update')return;
    const toolCallId=typeof data.toolCallId==='string'?data.toolCallId:null;
    if(type==='agent.tool.started'&&toolCallId)toolStarts.set(toolCallId,Date.now());
    if(type==='agent.tool.completed'&&toolCallId){const started=toolStarts.get(toolCallId);if(started)data.durationMs=Date.now()-started;toolStarts.delete(toolCallId);}
    if(type!=='agent.thinking.delta'&&type!=='agent.message.delta'){flushDeltas();enqueueEvent(type,data);return;}
    if(type==='agent.message.delta'){
      const text=String(data.text??'');const combined=assistantSyntaxTail+text;
      if(!malformedToolSyntaxObserved&&/(?:to=functions[./]|<\|channel\|>.*functions\.)/.test(combined)){malformedToolSyntaxObserved=true;enqueueEvent('agent.tool.malformed',{sample:combined.slice(-256)});}
      assistantSyntaxTail=combined.slice(-128);
    }
    const key=`${type}:${String(data.role??'')}:${String(data.contentIndex??'')}`;
    const existing=deltaBatches.get(key);const text=String(data.text??'');
    if(existing)existing.text+=text;else deltaBatches.set(key,{type,data:{...data,text:undefined},text,at:new Date().toISOString()});
    if((deltaBatches.get(key)?.text.length??0)>=8_192)flushDeltas();
    else if(!deltaTimer){deltaTimer=setTimeout(flushDeltas,500);deltaTimer.unref();}
  };
  const processObserver:SubjectProcessObserver=observation=>enqueueEvent(`subject.process.${observation.type}`,observation as unknown as Record<string,unknown>,true);
  const heartbeat=setInterval(()=>{renewLease(state.runId,WORKER_ID).catch(error=>logWorkerEvent(state.runId,'worker.lease.failed',{error:error instanceof Error?error.message:String(error)}));},HEARTBEAT_MS);heartbeat.unref();
  const repository=state.spec.subject.repository;const sourceSha=state.spec.subject.githubSha;const cwd=getSubjectPath(repository);
  try{
    await observedEvent('worker.claimed',{workerId:WORKER_ID,attempt:state.attempts});
    await assertNotCancelled(state.runId);
    await observedEvent('subject.preparing',{repository,sourceSha});
    await ensureSubject(repository,sourceSha,processObserver);await eventWrites;
    const deps=await ensureDependencies(repository,processObserver);await eventWrites;
    await observedEvent('subject.ready',deps);
    await assertNotCancelled(state.runId);

    const experimentRaw=await readFile(path.join(cwd,state.spec.experiment.path),'utf8');
    const definition=JSON.parse(experimentRaw) as ExperimentDefinition;
    const configErrors=validateExperimentDefinition(definition);
    if(configErrors.length)throw new ExperimentConfigError(configErrors);
    const resolvedAgent=resolveExperimentAgent(definition);
    const resolvedTools=resolveExperimentTools(definition);
    const toolEnvironment=await resolveToolEnvironment(cwd,resolvedTools);
    const inspectedTools=await inspectPiExtensions(toolEnvironment.extensions).catch(error=>{throw new ExperimentConfigError([`tool extension load failed: ${error instanceof Error?error.message:String(error)}`]);});
    const builtinTools=new Set(['read','bash','edit','write']);
    const inspectedByName=new Map(inspectedTools.map(tool=>[tool.name,tool]));
    const missingTools=toolEnvironment.allow.filter(name=>!builtinTools.has(name)&&!inspectedByName.has(name));
    if(missingTools.length)throw new ExperimentConfigError([`allowlisted tools were not registered: ${missingTools.join(', ')}`]);
    state=await saveRun({...state,spec:{...state.spec,agent:resolvedAgent,tools:resolvedTools}});
    await observedEvent('experiment.resolved',{id:definition.id,agent:resolvedAgent,tools:resolvedTools,verificationChecks:definition.verification.length});
    await observedEvent('tools.inspected',{enabled:toolEnvironment.allow.length,custom:inspectedTools.length,extensions:toolEnvironment.extensions.length});

    const taskPath=path.resolve(cwd,definition.taskFile);
    if(!taskPath.startsWith(`${path.resolve(cwd)}${path.sep}`))throw new ExperimentConfigError(['taskFile must stay inside subject repository']);
    const task=await readFile(taskPath,'utf8');
    const checks=normalizeVerification(definition);

    await observedEvent('subject.preflight.started');
    const preflight=await inspectSubjectReadiness({repository,expectedSha:sourceSha,experimentPath:state.spec.experiment.path,taskPath,provider:resolvedAgent.provider,dependenciesInstalled:deps.installed});
    await putArtifact({runId:state.runId,type:'subject.preflight',name:'preflight.json',mediaType:'application/json',content:JSON.stringify(preflight,null,2)});
    await observedEvent('subject.preflight.completed',preflight as unknown as Record<string,unknown>);
    if(!preflight.ok)throw new PreflightError(preflight.failures);
    await assertNotCancelled(state.runId);

    await observedEvent('agent.provider_probe.started',{provider:resolvedAgent.provider,model:resolvedAgent.model,timeoutMs:PROVIDER_PROBE_TIMEOUT_MS});
    const providerProbe=await probeProvider(resolvedAgent.provider,resolvedAgent.model,PROVIDER_PROBE_TIMEOUT_MS);
    await putArtifact({runId:state.runId,type:'agent.provider-probe',name:'provider-probe.json',mediaType:'application/json',content:JSON.stringify(providerProbe,null,2)});
    await observedEvent('agent.provider_probe.completed',providerProbe as unknown as Record<string,unknown>);
    if(!providerProbe.ok)throw new ProviderPreflightError(providerProbe.error??'unknown provider failure');
    await assertNotCancelled(state.runId);

    await putArtifact({runId:state.runId,type:'run.spec',name:'run-spec.json',mediaType:'application/json',content:JSON.stringify(state.spec,null,2)});
    const pinnedTools={
      allow:toolEnvironment.allow,
      extensions:toolEnvironment.extensions.map(extension=>({path:extension.path,sha256:extension.sha256})),
      bootstrap:toolEnvironment.bootstrap.map(entry=>({id:entry.id,entrypoint:entry.entrypoint,sha256:entry.sha256,timeoutMs:entry.timeoutMs,maxOutputBytes:entry.maxOutputBytes,required:entry.required})),
      effective:toolEnvironment.allow.map(name=>builtinTools.has(name)?{name,source:'pi-builtin',piVersion:PI_VERSION}:{...inspectedByName.get(name),source:'extension'}),
    };
    await putArtifact({runId:state.runId,type:'agent.tool-manifest',name:'tool-manifest.json',mediaType:'application/json',content:JSON.stringify(pinnedTools,null,2)});
    const bootstrapContext=await runBootstrap({cwd,repository,sourceSha,task,runId:state.runId,entries:toolEnvironment.bootstrap,observer:processObserver});await eventWrites;
    await assertNotCancelled(state.runId);

    const prompt=buildPrompt(task,bootstrapContext);
    const agentTimeoutMs=Math.min(MAX_AGENT_TIMEOUT_MS,Math.max(30_000,resolvedAgent.timeoutMs));
    const lockfile=await readFile(path.join(cwd,'pnpm-lock.yaml'));
    await putArtifact({runId:state.runId,type:'run.environment',name:'environment.json',mediaType:'application/json',content:JSON.stringify({runner:{commitSha:process.env.RAILWAY_GIT_COMMIT_SHA??null,deploymentId:process.env.RAILWAY_DEPLOYMENT_ID??null,node:process.versions.node,pi:PI_VERSION,pnpm:'10.17.1'},subject:{repository,sourceSha,lockfileSha256:sha256(lockfile)},agent:{...resolvedAgent,effectiveTimeoutMs:agentTimeoutMs},tools:pinnedTools,promptSha256:sha256(prompt)},null,2)});
    await putArtifact({runId:state.runId,type:'agent.prompt',name:'prompt.txt',mediaType:'text/plain',content:prompt});
    state=await saveRun({...state,status:'running',error:null,errorCode:null,startedAt:state.startedAt??new Date().toISOString()});
    await observedEvent('agent.started',{timeoutMs:agentTimeoutMs,startupTimeoutMs:AGENT_STARTUP_TIMEOUT_MS,idleTimeoutMs:AGENT_IDLE_TIMEOUT_MS,provider:resolvedAgent.provider,model:resolvedAgent.model,thinking:resolvedAgent.thinking,preflight:true});
    await observedEvent('agent.spawn.requested',{executable:process.env.WIND_TUNNEL_PI_BIN??'pi'});

    const controller=new AbortController();
    const cancellationWatcher=setInterval(()=>{isCancellationRequested(state.runId).then(cancelled=>{if(cancelled)controller.abort();}).catch(error=>logWorkerEvent(state.runId,'agent.cancel_poll.failed',{error:error instanceof Error?error.message:String(error)}));},CANCEL_POLL_MS);cancellationWatcher.unref();
    const enqueuePiLine=(line:string)=>{for(const event of normalizePiJsonLine(line))enqueueSemanticEvent(event.type,event.data);};
    const agentPromise=runPi({
      cwd,prompt,provider:resolvedAgent.provider,model:resolvedAgent.model,thinking:resolvedAgent.thinking??undefined,tools:toolEnvironment.allow,extensions:toolEnvironment.extensions.map(extension=>extension.absolutePath),
      timeoutMs:agentTimeoutMs,startupTimeoutMs:AGENT_STARTUP_TIMEOUT_MS,idleTimeoutMs:AGENT_IDLE_TIMEOUT_MS,heartbeatMs:5_000,signal:controller.signal,
      onSpawn:event=>enqueueEvent('agent.process.spawned',event,true),
      onFirstOutput:event=>enqueueEvent('agent.first_output',event,true),
      onHeartbeat:event=>enqueueEvent('agent.heartbeat',event,true),
      onSignal:event=>enqueueEvent('agent.signal.sent',event,true),
      onError:event=>enqueueEvent('agent.process.error',event,true),
      onStdoutLine:enqueuePiLine,
      onStderrLine:line=>enqueueEvent('agent.stderr',{text:line.slice(0,8_000)}),
    });
    let agent:Awaited<typeof agentPromise>;
    try{agent=await agentPromise;}finally{clearInterval(cancellationWatcher);}
    flushDeltas();
    enqueueEvent('agent.process.exited',{pid:agent.pid,exitCode:agent.exitCode,signal:agent.signal,durationMs:agent.durationMs,stdoutBytes:agent.stdoutBytes,stderrBytes:agent.stderrBytes},true);
    if(agent.timedOut)enqueueEvent('agent.timeout',{timeoutMs:agentTimeoutMs,startupTimeoutMs:AGENT_STARTUP_TIMEOUT_MS,idleTimeoutMs:AGENT_IDLE_TIMEOUT_MS,timeoutReason:agent.timeoutReason,firstOutputMs:agent.firstOutputMs,lastActivityAt:agent.lastActivityAt,stdoutBytes:agent.stdoutBytes,stderrBytes:agent.stderrBytes},true);
    await eventWrites;
    const diagnostics={pid:agent.pid,spawned:agent.pid!==null,exitCode:agent.exitCode,signal:agent.signal,durationMs:agent.durationMs,timedOut:agent.timedOut,timeoutReason:agent.timeoutReason,aborted:agent.aborted,firstOutputMs:agent.firstOutputMs,lastActivityAt:agent.lastActivityAt,stdoutBytes:agent.stdoutBytes,stderrBytes:agent.stderrBytes,provider:resolvedAgent.provider,model:resolvedAgent.model,diagnosticReportCaptured:Boolean(agent.diagnosticReport)};
    const agentArtifactNames=['pi.jsonl','pi.stderr.log','agent-diagnostics.json',...(agent.diagnosticReport?['node-diagnostic-report.json']:[])];
    enqueueEvent('artifact.upload.started',{artifacts:agentArtifactNames},true);await eventWrites;
    try{
      const uploads=[
        putArtifact({runId:state.runId,type:'pi.transcript',name:'pi.jsonl',mediaType:'application/x-ndjson',content:agent.stdout}),
        putArtifact({runId:state.runId,type:'pi.stderr',name:'pi.stderr.log',mediaType:'text/plain',content:agent.stderr}),
        putArtifact({runId:state.runId,type:'agent.diagnostics',name:'agent-diagnostics.json',mediaType:'application/json',content:JSON.stringify(diagnostics,null,2)}),
      ];
      if(agent.diagnosticReport)uploads.push(putArtifact({runId:state.runId,type:'agent.node-diagnostic-report',name:'node-diagnostic-report.json',mediaType:'application/json',content:agent.diagnosticReport}));
      await Promise.all(uploads);
      await observedEvent('artifact.upload.completed',{artifacts:agentArtifactNames});
    }catch(error){await observedEvent('artifact.upload.failed',{error:error instanceof Error?error.message:String(error)});throw error;}
    await captureWorkingTree(cwd,sourceSha,state.runId,agent.aborted||agent.timedOut||agent.exitCode!==0,processObserver);workspaceCaptured=true;await eventWrites;
    if(agent.aborted)throw new RunCancelledError();
    if(agent.timedOut)throw new AgentTimeoutError(agent.timeoutReason,agentTimeoutMs);
    if(agent.exitCode!==0)throw new Error(`Pi exited ${agent.exitCode}`);
    await observedEvent('agent.completed',{durationMs:agent.durationMs,exitCode:agent.exitCode,firstOutputMs:agent.firstOutputMs,lastActivityAt:agent.lastActivityAt,stdoutBytes:agent.stdoutBytes,stderrBytes:agent.stderrBytes});
    await assertNotCancelled(state.runId);

    state=await saveRun({...state,status:'verifying'});
    await appendEvent({runId:state.runId,type:'verification.started',at:new Date().toISOString(),data:{checks:checks.length}});
    const verification=await verify(cwd,checks,state.runId,processObserver);await eventWrites;
    await Promise.all([putArtifact({runId:state.runId,type:'verification.stdout',name:'verification.stdout.log',mediaType:'text/plain',content:verification.stdout}),putArtifact({runId:state.runId,type:'verification.stderr',name:'verification.stderr.log',mediaType:'text/plain',content:verification.stderr}),putArtifact({runId:state.runId,type:'verification.result',name:'verification.json',mediaType:'application/json',content:JSON.stringify(verification.results,null,2)})]);
    const passed=verification.results.filter(item=>item.required).every(item=>item.passed);const finishedAt=new Date().toISOString();
    state=await saveRun({...state,status:'completed',outcome:passed?'pass':'fail',finishedAt,error:null,errorCode:null});
    logWorkerEvent(state.runId,'run.completed',{outcome:state.outcome});await appendEvent({runId:state.runId,type:'run.completed',at:finishedAt,data:{outcome:state.outcome}});
  }catch(error){
    flushDeltas();await eventWrites;
    if(!workspaceCaptured){await captureWorkingTree(cwd,sourceSha,state.runId,true,processObserver).then(()=>{workspaceCaptured=true;}).catch(captureError=>logWorkerEvent(state.runId,'workspace.capture.failed',{error:captureError instanceof Error?captureError.message:String(captureError)}));await eventWrites;}
    const finishedAt=new Date().toISOString();const cancelled=error instanceof RunCancelledError||await isCancellationRequested(state.runId).catch(()=>false);
    if(cancelled){state=await saveRun({...state,status:'cancelled',outcome:null,error:null,errorCode:null,finishedAt});logWorkerEvent(state.runId,'run.cancelled');await appendEvent({runId:state.runId,type:'run.cancelled',at:finishedAt,data:{workerId:WORKER_ID}}).catch(()=>{});}
    else{const message=error instanceof Error?error.stack??error.message:String(error);const errorCode=error instanceof AgentTimeoutError?'agent_timeout':error instanceof PreflightError?'preflight_failed':error instanceof ProviderPreflightError?'provider_preflight_failed':error instanceof BootstrapError?'bootstrap_failed':error instanceof ExperimentConfigError?'experiment_invalid':'run_error';state=await saveRun({...state,status:'failed',outcome:null,error:message,errorCode,finishedAt});logWorkerEvent(state.runId,'run.failed',{error:message,errorCode});await putArtifact({runId:state.runId,type:'run.error',name:'error.txt',mediaType:'text/plain',content:message}).catch(()=>{});await appendEvent({runId:state.runId,type:'run.failed',at:finishedAt,data:{error:message,errorCode}}).catch(()=>{});}
  }finally{clearInterval(heartbeat);flushDeltas();await eventWrites;await cleanSubject(repository).catch(error=>logWorkerEvent(state.runId,'subject.cleanup.failed',{error:error instanceof Error?error.message:String(error)}));}
}

await ensureSchema();logWorkerEvent(null,'worker.ready',{pid:process.pid,pollMs:POLL_MS,heartbeatMs:HEARTBEAT_MS});
for(;;){const run=await claimNextRun(WORKER_ID);if(!run){await new Promise(resolve=>setTimeout(resolve,POLL_MS));continue;}await executeRun(run);}
