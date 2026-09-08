import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {putArtifact} from './artifact-store';
import {type Arm, type ExperimentDefinition, type RunLifecycle, type RunState, type VerificationResult} from './domain';
import {appendEvent, claimNextRun, ensureSchema, renewLease, saveRunState} from './postgres-store';
import {runPi} from './pi-adapter';

const APP_DIR = process.env.WIND_TUNNEL_APP_DIR ?? '/app';
const EVALUATOR_SHA = process.env.WIND_TUNNEL_EVALUATOR_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? 'local';
const RUNTIME_ROOT = process.env.WIND_TUNNEL_RUNTIME_DIR ?? '/tmp/nazare-wind-tunnel';
const WORKER_ID = process.env.WIND_TUNNEL_WORKER_ID ?? `${process.env.RAILWAY_SERVICE_NAME ?? 'worker'}:${process.pid}:${randomUUID().slice(0, 8)}`;
const POLL_MS = Number(process.env.WIND_TUNNEL_POLL_MS ?? 2_000);
const HEARTBEAT_MS = Number(process.env.WIND_TUNNEL_HEARTBEAT_MS ?? 20_000);
const PI_PACKAGE = process.env.WIND_TUNNEL_PI_PACKAGE ?? '@earendil-works/pi-coding-agent@0.85.1';

type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

async function runProcess(file: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {cwd, env: process.env});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current: string, chunk: Buffer | string) => (current + chunk.toString()).slice(-20_000_000);
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({exitCode, signal, stdout, stderr, durationMs: Date.now() - started, timedOut});
    });
  });
}

function runShell(command: string, cwd: string, timeoutMs = 30 * 60 * 1000) {
  return runProcess('/bin/sh', ['-lc', command], cwd, timeoutMs);
}

function deriveLifecycle(state: RunState): RunLifecycle {
  const arms = Object.values(state.arms);
  if (arms.some(arm => arm.status === 'failed')) return 'failed';
  if (arms.length > 0 && arms.every(arm => arm.status === 'completed')) return 'completed';
  if (arms.some(arm => arm.status === 'running')) return 'running';
  if (arms.some(arm => arm.status === 'verifying')) return 'verifying';
  return 'preparing';
}

function deriveOutcome(state: RunState) {
  const arms = Object.values(state.arms);
  if (!arms.length || !arms.every(arm => arm.status === 'completed')) return null;
  if (arms.some(arm => arm.outcome === 'fail')) return 'fail' as const;
  if (arms.some(arm => arm.outcome === 'inconclusive')) return 'inconclusive' as const;
  return 'pass' as const;
}

function buildPrompt(task: string, arm: Arm) {
  const common = [
    'Complete the requested repository change.',
    'Do not weaken tests, lint rules, policies, evidence contracts, or architectural constraints.',
    'Use the repository tools available to you and leave the worktree with the implementation applied.',
    '',
    'TASK:',
    task.trim(),
  ].join('\n');
  if (arm === 'raw') return common;
  return [
    common,
    '',
    'NAZARE COMPILED CONTEXT:',
    'A task projection is available at .nazare/task.json.',
    'Treat it as the authoritative starting boundary for source files, dependencies, policies, bindings, evidence, and invariants.',
    'Stay inside that projected neighborhood unless source evidence or verification requires expansion.',
  ].join('\n');
}

async function prepareSource(run: RunState) {
  if (run.spec.evaluator.githubSha !== EVALUATOR_SHA) {
    throw new Error(`Evaluator mismatch: run=${run.spec.evaluator.githubSha} worker=${EVALUATOR_SHA}`);
  }
  if (run.spec.agent.package && run.spec.agent.package !== PI_PACKAGE) {
    throw new Error(`Pi package mismatch: run=${run.spec.agent.package} worker=${PI_PACKAGE}`);
  }

  const experimentRaw = await readFile(path.join(APP_DIR, run.spec.experiment.path), 'utf8');
  const taskRaw = await readFile(path.join(APP_DIR, run.spec.task.path), 'utf8');
  if (sha256(experimentRaw) !== run.spec.evaluator.experimentDigest) throw new Error('Experiment digest does not match frozen RunSpec');
  if (sha256(taskRaw) !== run.spec.evaluator.taskDigest) throw new Error('Task digest does not match frozen RunSpec');
  const experiment = JSON.parse(experimentRaw) as ExperimentDefinition;

  const root = path.join(RUNTIME_ROOT, run.runId);
  const sourceDir = path.join(root, 'subject');
  await rm(root, {recursive: true, force: true});
  await mkdir(sourceDir, {recursive: true});

  const repoUrl = `https://github.com/${run.spec.subject.repository}.git`;
  const init = await runShell([
    'git init -q',
    `git remote add origin ${JSON.stringify(repoUrl)}`,
    `git fetch --depth 1 origin ${JSON.stringify(run.spec.subject.githubSha)}`,
    'git checkout --detach -q FETCH_HEAD',
  ].join(' && '), sourceDir, 180_000);
  if (init.exitCode !== 0) throw new Error(`Subject checkout failed: ${init.stderr || init.stdout}`);

  const head = await runShell('git rev-parse HEAD', sourceDir, 30_000);
  if (head.exitCode !== 0) throw new Error(head.stderr || head.stdout);
  const baselineCommit = head.stdout.trim();
  if (baselineCommit !== run.spec.subject.githubSha) {
    throw new Error(`Subject SHA mismatch after checkout: expected=${run.spec.subject.githubSha} actual=${baselineCommit}`);
  }

  const install = await runShell('npm ci', sourceDir, 20 * 60 * 1000);
  if (install.exitCode !== 0) throw new Error(`Subject dependency install failed: ${install.stderr || install.stdout}`);

  return {root, sourceDir, baselineCommit, experiment, task: taskRaw};
}

async function createWorktree(sourceDir: string, root: string, baselineCommit: string, arm: Arm) {
  const worktree = path.join(root, arm);
  const add = await runShell(`git worktree add --detach ${JSON.stringify(worktree)} ${JSON.stringify(baselineCommit)}`, sourceDir, 60_000);
  if (add.exitCode !== 0) throw new Error(add.stderr || add.stdout);
  const sharedNodeModules = path.join(sourceDir, 'node_modules');
  const armNodeModules = path.join(worktree, 'node_modules');
  if (existsSync(sharedNodeModules) && !existsSync(armNodeModules)) await symlink(sharedNodeModules, armNodeModules, 'dir');
  return worktree;
}

async function removeWorktree(sourceDir: string, worktree: string) {
  await runShell(`git worktree remove --force ${JSON.stringify(worktree)}`, sourceDir, 60_000);
  await rm(worktree, {recursive: true, force: true});
}

async function compileNazare(worktree: string, experiment: ExperimentDefinition) {
  await mkdir(path.join(worktree, '.nazare'), {recursive: true});
  const command = `npm run nazare:registry -- compile ${JSON.stringify(experiment.nazare.capabilityId)} ${JSON.stringify(experiment.nazare.requestedChange)}`;
  const result = await runShell(command, worktree, 60_000);
  if (result.exitCode !== 0) throw new Error(`Nazare compile failed: ${result.stderr || result.stdout}`);
  const jsonStart = result.stdout.indexOf('{');
  if (jsonStart < 0) throw new Error('Nazare compile did not return JSON');
  const projection = JSON.parse(result.stdout.slice(jsonStart));
  await writeFile(path.join(worktree, '.nazare', 'task.json'), JSON.stringify(projection, null, 2));
  return {projection, durationMs: result.durationMs, bytes: Buffer.byteLength(JSON.stringify(projection))};
}

async function collectDiff(worktree: string, baselineCommit: string) {
  const patch = await runShell(`git diff --no-ext-diff --binary ${JSON.stringify(baselineCommit)} -- . ':(exclude).nazare/task.json'`, worktree, 60_000);
  if (patch.exitCode !== 0) throw new Error(patch.stderr || patch.stdout);
  const changed = await runShell(`git diff --name-only ${JSON.stringify(baselineCommit)} -- . ':(exclude).nazare/task.json'`, worktree, 60_000);
  if (changed.exitCode !== 0) throw new Error(changed.stderr || changed.stdout);
  return {patch: patch.stdout, changedFiles: changed.stdout.split('\n').map(item => item.trim()).filter(Boolean)};
}

async function executeVerification(run: RunState, arm: Arm, worktree: string) {
  const results: VerificationResult[] = [];
  let stdout = '';
  let stderr = '';
  for (const check of run.spec.verification) {
    const result = await runShell(check.command, worktree, check.timeoutMs);
    stdout += `\n$ ${check.command}\n${result.stdout}`;
    stderr += `\n$ ${check.command}\n${result.stderr}`;
    results.push({
      id: check.id,
      command: check.command,
      required: check.required,
      status: result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutArtifact: null,
      stderrArtifact: null,
    });
  }
  const stdoutArtifact = await putArtifact({runId: run.runId, arm, type: 'verification.stdout', name: 'verifier.stdout.log', mediaType: 'text/plain', content: stdout});
  const stderrArtifact = await putArtifact({runId: run.runId, arm, type: 'verification.stderr', name: 'verifier.stderr.log', mediaType: 'text/plain', content: stderr});
  const enriched = results.map(result => ({...result, stdoutArtifact: stdoutArtifact.key, stderrArtifact: stderrArtifact.key}));
  await putArtifact({runId: run.runId, arm, type: 'verification.result', name: 'verification.json', mediaType: 'application/json', content: JSON.stringify(enriched, null, 2)});
  return enriched;
}

async function executeRun(claimed: RunState) {
  let state = claimed;
  let persistChain = Promise.resolve();
  const mutate = async (fn: (current: RunState) => RunState, event?: Parameters<typeof appendEvent>[0]) => {
    persistChain = persistChain.then(async () => {
      state = fn(state);
      state.status = deriveLifecycle(state);
      state.outcome = deriveOutcome(state);
      state.finishedAt = ['completed', 'failed', 'cancelled'].includes(state.status) ? (state.finishedAt ?? new Date().toISOString()) : null;
      state = await saveRunState(state);
      if (event) await appendEvent(event);
    });
    await persistChain;
  };

  const heartbeat = setInterval(() => {
    renewLease(claimed.runId, WORKER_ID).catch(error => console.error(`Lease heartbeat failed for ${claimed.runId}`, error));
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let root = '';
  try {
    const prepared = await prepareSource(state);
    root = prepared.root;
    await putArtifact({runId: state.runId, type: 'run.spec', name: 'run-spec.json', mediaType: 'application/json', content: JSON.stringify(state.spec, null, 2)});
    await appendEvent({runId: state.runId, type: 'run.prepared', at: new Date().toISOString(), data: {
      evaluatorSha: state.spec.evaluator.githubSha,
      subjectSha: state.spec.subject.githubSha,
      workspaceBaselineCommit: prepared.baselineCommit,
      workerId: WORKER_ID,
    }});
    await mutate(current => ({...current, arms: Object.fromEntries(Object.entries(current.arms).map(([name, arm]) => [name, {...arm, workspaceBaselineCommit: prepared.baselineCommit}]))}));

    const runArm = async (arm: Arm) => {
      const startedAt = new Date().toISOString();
      let worktree = '';
      try {
        await mutate(current => ({...current, arms: {...current.arms, [arm]: {...current.arms[arm], status: 'preparing', startedAt, error: null}}}), {runId: state.runId, type: 'arm.preparing', arm, at: startedAt});
        worktree = await createWorktree(prepared.sourceDir, prepared.root, prepared.baselineCommit, arm);
        const compiled = arm === 'nazare' ? await compileNazare(worktree, prepared.experiment) : null;
        if (compiled) await putArtifact({runId: state.runId, arm, type: 'nazare.compiled-task', name: 'compiled-task.json', mediaType: 'application/json', content: JSON.stringify(compiled.projection, null, 2)});
        const prompt = buildPrompt(prepared.task, arm);
        await putArtifact({runId: state.runId, arm, type: 'agent.prompt', name: 'prompt.txt', mediaType: 'text/plain', content: prompt});

        await mutate(current => ({...current, arms: {...current.arms, [arm]: {...current.arms[arm], status: 'running'}}}), {runId: state.runId, type: 'agent.started', arm, at: new Date().toISOString()});
        const agent = await runPi({
          cwd: worktree,
          prompt,
          provider: state.spec.agent.provider ?? undefined,
          model: state.spec.agent.model ?? undefined,
          thinking: state.spec.agent.thinking ?? undefined,
          timeoutMs: state.spec.agent.timeoutMs,
        });
        await Promise.all([
          putArtifact({runId: state.runId, arm, type: 'pi.transcript', name: 'pi.jsonl', mediaType: 'application/x-ndjson', content: agent.stdout}),
          putArtifact({runId: state.runId, arm, type: 'pi.stderr', name: 'pi.stderr.log', mediaType: 'text/plain', content: agent.stderr}),
        ]);
        if (agent.exitCode !== 0 || agent.timedOut) throw new Error(agent.timedOut ? 'Pi execution timed out' : `Pi exited with code ${agent.exitCode}`);

        const diff = await collectDiff(worktree, prepared.baselineCommit);
        await Promise.all([
          putArtifact({runId: state.runId, arm, type: 'git.patch', name: 'patch.diff', mediaType: 'text/x-diff', content: diff.patch}),
          putArtifact({runId: state.runId, arm, type: 'git.changed-files', name: 'changed-files.json', mediaType: 'application/json', content: JSON.stringify(diff.changedFiles, null, 2)}),
        ]);

        await mutate(current => ({...current, arms: {...current.arms, [arm]: {...current.arms[arm], status: 'verifying'}}}), {runId: state.runId, type: 'verification.started', arm, at: new Date().toISOString()});
        const verification = await executeVerification(state, arm, worktree);
        const requiredPassed = verification.filter(item => item.required).every(item => item.status === 'passed');
        const finishedAt = new Date().toISOString();
        await putArtifact({
          runId: state.runId,
          arm,
          type: 'metrics',
          name: 'metrics.json',
          mediaType: 'application/json',
          content: JSON.stringify({
            evaluatorSha: state.spec.evaluator.githubSha,
            subjectSha: state.spec.subject.githubSha,
            agentDurationMs: agent.durationMs,
            patchBytes: Buffer.byteLength(diff.patch),
            filesChanged: diff.changedFiles.length,
            nazareCompileDurationMs: compiled?.durationMs ?? null,
            nazareContextBytes: compiled?.bytes ?? null,
            verificationDurationMs: verification.reduce((sum, item) => sum + item.durationMs, 0),
          }, null, 2),
        });
        await mutate(current => ({...current, arms: {...current.arms, [arm]: {...current.arms[arm], status: 'completed', outcome: requiredPassed ? 'pass' : 'fail', finishedAt, error: null}}}), {runId: state.runId, type: 'arm.completed', arm, at: finishedAt, data: {outcome: requiredPassed ? 'pass' : 'fail'}});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const finishedAt = new Date().toISOString();
        try { await putArtifact({runId: state.runId, arm, type: 'arm.error', name: 'error.txt', mediaType: 'text/plain', content: message}); } catch {}
        await mutate(current => ({...current, error: current.error ?? message, arms: {...current.arms, [arm]: {...current.arms[arm], status: 'failed', outcome: null, finishedAt, error: message}}}), {runId: state.runId, type: 'arm.failed', arm, at: finishedAt, data: {error: message}});
      } finally {
        if (worktree) await removeWorktree(prepared.sourceDir, worktree);
      }
    };

    await Promise.all(state.spec.arms.map(runArm));
    await persistChain;
    if (state.status === 'completed') await appendEvent({runId: state.runId, type: 'run.completed', at: new Date().toISOString(), data: {outcome: state.outcome}});
    else if (state.status === 'failed') await appendEvent({runId: state.runId, type: 'run.failed', at: new Date().toISOString(), data: {error: state.error}});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state = await saveRunState({...state, status: 'failed', outcome: null, error: message, finishedAt: new Date().toISOString()});
    await appendEvent({runId: state.runId, type: 'run.failed', at: new Date().toISOString(), data: {error: message}});
  } finally {
    clearInterval(heartbeat);
    if (root) await rm(root, {recursive: true, force: true});
  }
}

async function main() {
  if (EVALUATOR_SHA === 'local' && process.env.RAILWAY_ENVIRONMENT) {
    throw new Error('RAILWAY_GIT_COMMIT_SHA is required in Railway; refusing unverifiable evaluator deployment');
  }
  await ensureSchema();
  console.log(`Nazare Wind Tunnel worker ${WORKER_ID}`);
  console.log(`Evaluator SHA: ${EVALUATOR_SHA}`);
  while (true) {
    try {
      const run = await claimNextRun(WORKER_ID);
      if (run) await executeRun(run);
      else await new Promise(resolve => setTimeout(resolve, POLL_MS));
    } catch (error) {
      console.error('Worker loop error', error);
      await new Promise(resolve => setTimeout(resolve, Math.max(POLL_MS, 5_000)));
    }
  }
}

await main();
