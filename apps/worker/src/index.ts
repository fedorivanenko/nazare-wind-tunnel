import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ExperimentDefinition, RunState, VerificationSpec} from '@nazare/wind-tunnel-domain';
import {MAX_AGENT_TIMEOUT_MS, normalizeVerification, resolveExperimentAgent, validateExperimentDefinition} from '@nazare/wind-tunnel-domain';
import {appendEvent, claimNextRun, ensureSchema, isCancellationRequested, putArtifact, renewLease, saveRun} from '@nazare/wind-tunnel-storage';
import {cleanSubject, ensureDependencies, ensureSubject, getSubjectPath, inspectSubjectReadiness, runSubjectProcess, type SubjectProcessObserver} from '@nazare/wind-tunnel-subject-manager';
import {normalizePiJsonLine, runPi, type PiTimeoutReason} from '@nazare/wind-tunnel-pi';

const WORKER_ID=process.env.WIND_TUNNEL_WORKER_ID??`${process.env.RAILWAY_SERVICE_NAME??'worker'}:${process.pid}:${randomUUID().slice(0,8)}`;
const POLL_MS=Number(process.env.WIND_TUNNEL_POLL_MS??2_000);
const HEARTBEAT_MS=Number(process.env.WIND_TUNNEL_HEARTBEAT_MS??5_000);
const AGENT_STARTUP_TIMEOUT_MS=Number(process.env.WIND_TUNNEL_AGENT_STARTUP_TIMEOUT_MS??15_000);
const AGENT_IDLE_TIMEOUT_MS=Number(process.env.WIND_TUNNEL_AGENT_IDLE_TIMEOUT_MS??60_000);
const CANCEL_POLL_MS=750;

class RunCancelledError extends Error{constructor(){super('Run cancelled');this.name='RunCancelledError';}}
class AgentTimeoutError extends Error{constructor(reason:PiTimeoutReason,timeoutMs:number){super(`Pi timed out (${reason??'unknown'}); overall budget ${timeoutMs}ms, startup ${AGENT_STARTUP_TIMEOUT_MS}ms, idle ${AGENT_IDLE_TIMEOUT_MS}ms`);this.name='AgentTimeoutError';}}
class PreflightError extends Error{constructor(failures:string[]){super(`Subject preflight failed: ${failures.join('; ')}`);this.name='PreflightError';}}
class ExperimentConfigError extends Error{constructor(failures:string[]){super(`Experiment configuration invalid: ${failures.join('; ')}`);this.name='ExperimentConfigError';}}

function logWorkerEvent(runId:string|null,event:string,data:Record<string,unknown>={}){
  console.log(JSON.stringify({at:new Date().toISOString(),service:'wind-tunnel-worker',workerId:WORKER_ID,runId,event,...data}));
}

function buildPrompt(task:string,arm:'raw'|'nazare'){
  const common=['Complete the requested repository change.','Do not weaken tests, lint rules, policies, evidence contracts, or architectural constraints.','Leave the working checkout with the implementation applied.','','TASK:',task.trim()].join('\n');
  return arm==='raw'?common:`${common}\n\nNAZARE COMPILED CONTEXT:\nA task projection is available at .nazare/task.json. Treat it as the authoritative starting boundary.`;
}
async function assertNotCancelled(runId:string){if(await isCancellationRequested(runId))throw new RunCancelledError();}
async function compileNazare(cwd:string,definition:ExperimentDefinition,observer?:SubjectProcessObserver){
  if(!definition.nazare)throw new Error('nazare arm requires experiment.nazare configuration');
  await mkdir(path.join(cwd,'.nazare'),{recursive:true});
  const result=await runSubjectProcess('pnpm',['run','nazare:registry','compile',definition.nazare.capabilityId,definition.nazare.requestedChange],cwd,60_000,observer);
  if(result.exitCode!==0||result.timedOut)throw new Error(`Nazare compile failed: ${result.stderr||result.stdout}`);
  const jsonStart=result.stdout.indexOf('{');if(jsonStart<0)throw new Error('Nazare compiler returned no JSON');
  const projection=JSON.parse(result.stdout.slice(jsonStart));
  await writeFile(path.join(cwd,'.nazare','task.json'),JSON.stringify(projection,null,2));
  return projection;
}
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

async function executeRun(claimed:RunState){
  let state=claimed;
  let eventWrites=Promise.resolve();
  const enqueueEvent=(type:string,data?:Record<string,unknown>,log=false)=>{
    if(log)logWorkerEvent(state.runId,type,data);
    eventWrites=eventWrites.then(()=>appendEvent({runId:state.runId,type,at:new Date().toISOString(),data})).then(()=>undefined).catch(error=>console.error('event write failed',error));
  };
  const observedEvent=async(type:string,data:Record<string,unknown>={})=>{logWorkerEvent(state.runId,type,data);await appendEvent({runId:state.runId,type,at:new Date().toISOString(),data});};
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
    const configErrors=validateExperimentDefinition(definition,state.spec.arm);
    if(configErrors.length)throw new ExperimentConfigError(configErrors);
    const resolvedAgent=resolveExperimentAgent(definition);
    state=await saveRun({...state,spec:{...state.spec,agent:resolvedAgent}});
    await observedEvent('experiment.resolved',{id:definition.id,agent:resolvedAgent,verificationChecks:definition.verification.length});

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

    await putArtifact({runId:state.runId,type:'run.spec',name:'run-spec.json',mediaType:'application/json',content:JSON.stringify(state.spec,null,2)});
    if(state.spec.arm==='nazare'){
      state=await saveRun({...state,status:'compiling'});
      await observedEvent('nazare.compile.started');
      const projection=await compileNazare(cwd,definition,processObserver);await eventWrites;
      await putArtifact({runId:state.runId,type:'nazare.compiled-task',name:'compiled-task.json',mediaType:'application/json',content:JSON.stringify(projection,null,2)});
      await observedEvent('nazare.compile.completed');
      await assertNotCancelled(state.runId);
    }

    const prompt=buildPrompt(task,state.spec.arm);
    await putArtifact({runId:state.runId,type:'agent.prompt',name:'prompt.txt',mediaType:'text/plain',content:prompt});
    const agentTimeoutMs=Math.min(MAX_AGENT_TIMEOUT_MS,Math.max(30_000,resolvedAgent.timeoutMs));
    state=await saveRun({...state,status:'running',error:null,errorCode:null,startedAt:state.startedAt??new Date().toISOString()});
    await observedEvent('agent.started',{timeoutMs:agentTimeoutMs,startupTimeoutMs:AGENT_STARTUP_TIMEOUT_MS,idleTimeoutMs:AGENT_IDLE_TIMEOUT_MS,provider:resolvedAgent.provider,model:resolvedAgent.model,thinking:resolvedAgent.thinking,preflight:true});
    await observedEvent('agent.spawn.requested',{executable:process.env.WIND_TUNNEL_PI_BIN??'pi'});

    const controller=new AbortController();
    const cancellationWatcher=setInterval(()=>{isCancellationRequested(state.runId).then(cancelled=>{if(cancelled)controller.abort();}).catch(error=>logWorkerEvent(state.runId,'agent.cancel_poll.failed',{error:error instanceof Error?error.message:String(error)}));},CANCEL_POLL_MS);cancellationWatcher.unref();
    const enqueuePiLine=(line:string)=>{for(const event of normalizePiJsonLine(line))enqueueEvent(event.type,event.data);};
    const agentPromise=runPi({
      cwd,prompt,provider:resolvedAgent.provider,model:resolvedAgent.model,thinking:resolvedAgent.thinking??undefined,
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
    enqueueEvent('agent.process.exited',{pid:agent.pid,exitCode:agent.exitCode,signal:agent.signal,durationMs:agent.durationMs,stdoutBytes:agent.stdoutBytes,stderrBytes:agent.stderrBytes},true);
    if(agent.timedOut)enqueueEvent('agent.timeout',{timeoutMs:agentTimeoutMs,startupTimeoutMs:AGENT_STARTUP_TIMEOUT_MS,idleTimeoutMs:AGENT_IDLE_TIMEOUT_MS,timeoutReason:agent.timeoutReason,firstOutputMs:agent.firstOutputMs,lastActivityAt:agent.lastActivityAt,stdoutBytes:agent.stdoutBytes,stderrBytes:agent.stderrBytes},true);
    await eventWrites;
    const diagnostics={pid:agent.pid,spawned:agent.pid!==null,exitCode:agent.exitCode,signal:agent.signal,durationMs:agent.durationMs,timedOut:agent.timedOut,timeoutReason:agent.timeoutReason,aborted:agent.aborted,firstOutputMs:agent.firstOutputMs,lastActivityAt:agent.lastActivityAt,stdoutBytes:agent.stdoutBytes,stderrBytes:agent.stderrBytes,provider:resolvedAgent.provider,model:resolvedAgent.model};
    enqueueEvent('artifact.upload.started',{artifacts:['pi.jsonl','pi.stderr.log','agent-diagnostics.json']},true);await eventWrites;
    try{
      await Promise.all([
        putArtifact({runId:state.runId,type:'pi.transcript',name:'pi.jsonl',mediaType:'application/x-ndjson',content:agent.stdout}),
        putArtifact({runId:state.runId,type:'pi.stderr',name:'pi.stderr.log',mediaType:'text/plain',content:agent.stderr}),
        putArtifact({runId:state.runId,type:'agent.diagnostics',name:'agent-diagnostics.json',mediaType:'application/json',content:JSON.stringify(diagnostics,null,2)}),
      ]);
      await observedEvent('artifact.upload.completed',{artifacts:['pi.jsonl','pi.stderr.log','agent-diagnostics.json']});
    }catch(error){await observedEvent('artifact.upload.failed',{error:error instanceof Error?error.message:String(error)});throw error;}
    if(agent.aborted)throw new RunCancelledError();
    if(agent.timedOut)throw new AgentTimeoutError(agent.timeoutReason,agentTimeoutMs);
    if(agent.exitCode!==0)throw new Error(`Pi exited ${agent.exitCode}`);
    await observedEvent('agent.completed',{durationMs:agent.durationMs,exitCode:agent.exitCode,firstOutputMs:agent.firstOutputMs,lastActivityAt:agent.lastActivityAt,stdoutBytes:agent.stdoutBytes,stderrBytes:agent.stderrBytes});
    await assertNotCancelled(state.runId);

    const patch=await runSubjectProcess('git',['diff','--no-ext-diff','--binary',sourceSha,'--','.',' :(exclude).nazare/task.json'.trim()],cwd,60_000,processObserver);
    const changed=await runSubjectProcess('git',['diff','--name-only',sourceSha,'--','.'],cwd,60_000,processObserver);await eventWrites;
    await Promise.all([putArtifact({runId:state.runId,type:'git.patch',name:'patch.diff',mediaType:'text/x-diff',content:patch.stdout}),putArtifact({runId:state.runId,type:'git.changed-files',name:'changed-files.txt',mediaType:'text/plain',content:changed.stdout})]);
    state=await saveRun({...state,status:'verifying'});
    await appendEvent({runId:state.runId,type:'verification.started',at:new Date().toISOString(),data:{checks:checks.length}});
    const verification=await verify(cwd,checks,state.runId,processObserver);await eventWrites;
    await Promise.all([putArtifact({runId:state.runId,type:'verification.stdout',name:'verification.stdout.log',mediaType:'text/plain',content:verification.stdout}),putArtifact({runId:state.runId,type:'verification.stderr',name:'verification.stderr.log',mediaType:'text/plain',content:verification.stderr}),putArtifact({runId:state.runId,type:'verification.result',name:'verification.json',mediaType:'application/json',content:JSON.stringify(verification.results,null,2)})]);
    const passed=verification.results.filter(item=>item.required).every(item=>item.passed);const finishedAt=new Date().toISOString();
    state=await saveRun({...state,status:'completed',outcome:passed?'pass':'fail',finishedAt,error:null,errorCode:null});
    logWorkerEvent(state.runId,'run.completed',{outcome:state.outcome});await appendEvent({runId:state.runId,type:'run.completed',at:finishedAt,data:{outcome:state.outcome}});
  }catch(error){
    const finishedAt=new Date().toISOString();const cancelled=error instanceof RunCancelledError||await isCancellationRequested(state.runId).catch(()=>false);
    if(cancelled){state=await saveRun({...state,status:'cancelled',outcome:null,error:null,errorCode:null,finishedAt});logWorkerEvent(state.runId,'run.cancelled');await appendEvent({runId:state.runId,type:'run.cancelled',at:finishedAt,data:{workerId:WORKER_ID}}).catch(()=>{});}
    else{const message=error instanceof Error?error.stack??error.message:String(error);const errorCode=error instanceof AgentTimeoutError?'agent_timeout':error instanceof PreflightError?'preflight_failed':error instanceof ExperimentConfigError?'experiment_invalid':'run_error';state=await saveRun({...state,status:'failed',outcome:null,error:message,errorCode,finishedAt});logWorkerEvent(state.runId,'run.failed',{error:message,errorCode});await putArtifact({runId:state.runId,type:'run.error',name:'error.txt',mediaType:'text/plain',content:message}).catch(()=>{});await appendEvent({runId:state.runId,type:'run.failed',at:finishedAt,data:{error:message,errorCode}}).catch(()=>{});}
  }finally{clearInterval(heartbeat);await eventWrites;await cleanSubject(repository).catch(error=>logWorkerEvent(state.runId,'subject.cleanup.failed',{error:error instanceof Error?error.message:String(error)}));}
}

await ensureSchema();logWorkerEvent(null,'worker.ready',{pid:process.pid,pollMs:POLL_MS,heartbeatMs:HEARTBEAT_MS});
for(;;){const run=await claimNextRun(WORKER_ID);if(!run){await new Promise(resolve=>setTimeout(resolve,POLL_MS));continue;}await executeRun(run);}
