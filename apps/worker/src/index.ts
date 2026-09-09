import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ExperimentDefinition, RunState, VerificationSpec} from '@nazare/wind-tunnel-domain';
import {normalizeVerification} from '@nazare/wind-tunnel-domain';
import {appendEvent, claimNextRun, ensureSchema, isCancellationRequested, putArtifact, renewLease, saveRun} from '@nazare/wind-tunnel-storage';
import {cleanSubject, ensureDependencies, ensureSubject, getSubjectPath, runSubjectProcess} from '@nazare/wind-tunnel-subject-manager';
import {runPi} from '@nazare/wind-tunnel-pi';

const WORKER_ID = process.env.WIND_TUNNEL_WORKER_ID ?? `${process.env.RAILWAY_SERVICE_NAME ?? 'worker'}:${process.pid}:${randomUUID().slice(0,8)}`;
const POLL_MS = Number(process.env.WIND_TUNNEL_POLL_MS ?? 2_000);
const HEARTBEAT_MS = Number(process.env.WIND_TUNNEL_HEARTBEAT_MS ?? 5_000);
const MAX_MODEL_TIMEOUT_MS = 30_000;
const CANCEL_POLL_MS = 750;

class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled');
    this.name = 'RunCancelledError';
  }
}

class AgentTimeoutError extends Error {
  constructor() {
    super(`Pi exceeded hard ${MAX_MODEL_TIMEOUT_MS}ms model budget`);
    this.name = 'AgentTimeoutError';
  }
}

function buildPrompt(task: string, arm: 'raw' | 'nazare') {
  const common = [
    'Complete the requested repository change.',
    'Do not weaken tests, lint rules, policies, evidence contracts, or architectural constraints.',
    'Leave the working checkout with the implementation applied.',
    '',
    'TASK:',
    task.trim(),
  ].join('\n');
  if (arm === 'raw') return common;
  return `${common}\n\nNAZARE COMPILED CONTEXT:\nA task projection is available at .nazare/task.json. Treat it as the authoritative starting boundary.`;
}

async function assertNotCancelled(runId: string) {
  if (await isCancellationRequested(runId)) throw new RunCancelledError();
}

async function compileNazare(cwd: string, definition: ExperimentDefinition) {
  if (!definition.nazare) throw new Error('nazare arm requires experiment.nazare configuration');
  await mkdir(path.join(cwd, '.nazare'), {recursive:true});
  const result = await runSubjectProcess('pnpm', [
    'run','nazare:registry','compile',definition.nazare.capabilityId,definition.nazare.requestedChange,
  ], cwd, 60_000);
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`Nazare compile failed: ${result.stderr || result.stdout}`);
  const jsonStart = result.stdout.indexOf('{');
  if (jsonStart < 0) throw new Error('Nazare compiler returned no JSON');
  const projection = JSON.parse(result.stdout.slice(jsonStart));
  await writeFile(path.join(cwd,'.nazare','task.json'), JSON.stringify(projection,null,2));
  return projection;
}

async function verify(cwd: string, checks: VerificationSpec[], runId: string) {
  const results = [];
  let stdout = '';
  let stderr = '';
  for (const check of checks) {
    await assertNotCancelled(runId);
    await appendEvent({runId,type:'verification.check.started',at:new Date().toISOString(),data:{id:check.id,command:check.command}});
    const result = await runSubjectProcess('/bin/sh',['-lc',check.command],cwd,check.timeoutMs);
    stdout += `\n$ ${check.command}\n${result.stdout}`;
    stderr += `\n$ ${check.command}\n${result.stderr}`;
    const item = {
      id:check.id,
      command:check.command,
      required:check.required,
      passed:result.exitCode === 0 && !result.timedOut,
      exitCode:result.exitCode,
      timedOut:result.timedOut,
      durationMs:result.durationMs,
    };
    results.push(item);
    await appendEvent({runId,type:'verification.check.completed',at:new Date().toISOString(),data:item});
  }
  return {results,stdout,stderr};
}

async function executeRun(claimed: RunState) {
  let state = claimed;
  const heartbeat = setInterval(() => {
    renewLease(state.runId, WORKER_ID).catch(error => console.error('lease heartbeat failed', error));
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const repository = state.spec.subject.repository;
  const sourceSha = state.spec.subject.githubSha;
  const cwd = getSubjectPath(repository);

  try {
    await appendEvent({runId:state.runId,type:'worker.claimed',at:new Date().toISOString(),data:{workerId:WORKER_ID,attempt:state.attempts}});
    await assertNotCancelled(state.runId);
    await appendEvent({runId:state.runId,type:'subject.preparing',at:new Date().toISOString(),data:{repository,sourceSha}});
    await ensureSubject(repository, sourceSha);
    const deps = await ensureDependencies(repository);
    await appendEvent({runId:state.runId,type:'subject.ready',at:new Date().toISOString(),data:deps});
    await assertNotCancelled(state.runId);

    const experimentRaw = await readFile(path.join(cwd,state.spec.experiment.path),'utf8');
    const definition = JSON.parse(experimentRaw) as ExperimentDefinition;
    const taskPath = path.resolve(cwd, definition.taskFile);
    if (!taskPath.startsWith(`${path.resolve(cwd)}${path.sep}`)) throw new Error('taskFile must stay inside subject repository');
    const task = await readFile(taskPath,'utf8');
    const checks = normalizeVerification(definition);

    await putArtifact({runId:state.runId,type:'run.spec',name:'run-spec.json',mediaType:'application/json',content:JSON.stringify(state.spec,null,2)});
    if (state.spec.arm === 'nazare') {
      state = await saveRun({...state,status:'compiling'});
      await appendEvent({runId:state.runId,type:'nazare.compile.started',at:new Date().toISOString()});
      const projection = await compileNazare(cwd, definition);
      await putArtifact({runId:state.runId,type:'nazare.compiled-task',name:'compiled-task.json',mediaType:'application/json',content:JSON.stringify(projection,null,2)});
      await appendEvent({runId:state.runId,type:'nazare.compile.completed',at:new Date().toISOString()});
      await assertNotCancelled(state.runId);
    }

    const prompt = buildPrompt(task, state.spec.arm);
    await putArtifact({runId:state.runId,type:'agent.prompt',name:'prompt.txt',mediaType:'text/plain',content:prompt});

    const requestedTimeout = Number(state.spec.agent.timeoutMs || MAX_MODEL_TIMEOUT_MS);
    const modelTimeoutMs = Math.min(MAX_MODEL_TIMEOUT_MS, Math.max(1_000, requestedTimeout));
    state = await saveRun({...state,status:'running',error:null,errorCode:null,startedAt:state.startedAt ?? new Date().toISOString()});
    await appendEvent({runId:state.runId,type:'agent.started',at:new Date().toISOString(),data:{timeoutMs:modelTimeoutMs,provider:state.spec.agent.provider,model:state.spec.agent.model,thinking:state.spec.agent.thinking}});

    const controller = new AbortController();
    const cancellationWatcher = setInterval(() => {
      isCancellationRequested(state.runId)
        .then(cancelled => { if (cancelled) controller.abort(); })
        .catch(error => console.error('cancel poll failed', error));
    }, CANCEL_POLL_MS);
    cancellationWatcher.unref();

    let eventWrites = Promise.resolve();
    const enqueueOutputEvent = (type: string, line: string) => {
      const text = line.slice(0, 8_000);
      eventWrites = eventWrites.then(() => appendEvent({runId:state.runId,type,at:new Date().toISOString(),data:{text}})).then(() => undefined).catch(() => undefined);
    };

    const agent = await runPi({
      cwd,
      prompt,
      provider:state.spec.agent.provider ?? undefined,
      model:state.spec.agent.model ?? undefined,
      thinking:state.spec.agent.thinking ?? undefined,
      timeoutMs:modelTimeoutMs,
      signal:controller.signal,
      onStdoutLine: line => enqueueOutputEvent('agent.output', line),
      onStderrLine: line => enqueueOutputEvent('agent.stderr', line),
    });
    clearInterval(cancellationWatcher);
    await eventWrites;

    await Promise.all([
      putArtifact({runId:state.runId,type:'pi.transcript',name:'pi.jsonl',mediaType:'application/x-ndjson',content:agent.stdout}),
      putArtifact({runId:state.runId,type:'pi.stderr',name:'pi.stderr.log',mediaType:'text/plain',content:agent.stderr}),
    ]);

    if (agent.aborted) throw new RunCancelledError();
    if (agent.timedOut) {
      await appendEvent({runId:state.runId,type:'agent.timeout',at:new Date().toISOString(),data:{timeoutMs:modelTimeoutMs}});
      throw new AgentTimeoutError();
    }
    if (agent.exitCode !== 0) throw new Error(`Pi exited ${agent.exitCode}`);
    await appendEvent({runId:state.runId,type:'agent.completed',at:new Date().toISOString(),data:{durationMs:agent.durationMs,exitCode:agent.exitCode}});
    await assertNotCancelled(state.runId);

    const patch = await runSubjectProcess('git',['diff','--no-ext-diff','--binary',sourceSha,'--','.',' :(exclude).nazare/task.json'.trim()],cwd,60_000);
    const changed = await runSubjectProcess('git',['diff','--name-only',sourceSha,'--','.'],cwd,60_000);
    await Promise.all([
      putArtifact({runId:state.runId,type:'git.patch',name:'patch.diff',mediaType:'text/x-diff',content:patch.stdout}),
      putArtifact({runId:state.runId,type:'git.changed-files',name:'changed-files.txt',mediaType:'text/plain',content:changed.stdout}),
    ]);

    state = await saveRun({...state,status:'verifying'});
    await appendEvent({runId:state.runId,type:'verification.started',at:new Date().toISOString(),data:{checks:checks.length}});
    const verification = await verify(cwd, checks, state.runId);
    await Promise.all([
      putArtifact({runId:state.runId,type:'verification.stdout',name:'verification.stdout.log',mediaType:'text/plain',content:verification.stdout}),
      putArtifact({runId:state.runId,type:'verification.stderr',name:'verification.stderr.log',mediaType:'text/plain',content:verification.stderr}),
      putArtifact({runId:state.runId,type:'verification.result',name:'verification.json',mediaType:'application/json',content:JSON.stringify(verification.results,null,2)}),
    ]);
    const passed = verification.results.filter(item => item.required).every(item => item.passed);
    const finishedAt = new Date().toISOString();
    state = await saveRun({...state,status:'completed',outcome:passed ? 'pass' : 'fail',finishedAt,error:null,errorCode:null});
    await appendEvent({runId:state.runId,type:'run.completed',at:finishedAt,data:{outcome:state.outcome}});
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const cancelled = error instanceof RunCancelledError || await isCancellationRequested(state.runId).catch(() => false);
    if (cancelled) {
      state = await saveRun({...state,status:'cancelled',outcome:null,error:null,errorCode:null,finishedAt});
      await appendEvent({runId:state.runId,type:'run.cancelled',at:finishedAt,data:{workerId:WORKER_ID}}).catch(() => {});
    } else {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      const errorCode = error instanceof AgentTimeoutError ? 'agent_timeout' : 'run_error';
      state = await saveRun({...state,status:'failed',outcome:null,error:message,errorCode,finishedAt});
      await putArtifact({runId:state.runId,type:'run.error',name:'error.txt',mediaType:'text/plain',content:message}).catch(() => {});
      await appendEvent({runId:state.runId,type:'run.failed',at:finishedAt,data:{error:message,errorCode}}).catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
    await cleanSubject(repository).catch(error => console.error('subject cleanup failed', error));
  }
}

await ensureSchema();
console.log(`Nazare Wind Tunnel worker ${WORKER_ID} ready`);

for (;;) {
  const run = await claimNextRun(WORKER_ID);
  if (!run) {
    await new Promise(resolve => setTimeout(resolve,POLL_MS));
    continue;
  }
  await executeRun(run);
}
