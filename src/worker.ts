import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {putArtifact} from './artifact-store';
import {type Arm, type EnvironmentSpec, type ExperimentDefinition, type FailureKind, type RunLifecycle, type RunState, type VerificationResult} from './domain';
import {appendEvent, claimNextRun, ensureSchema, renewLease, saveRunState} from './postgres-store';
import {runPi} from './pi-adapter';

const APP_DIR = process.env.WIND_TUNNEL_APP_DIR ?? '/app';
const EVALUATOR_SHA = process.env.WIND_TUNNEL_EVALUATOR_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? 'local';
const WORKER_IMAGE_DIGEST = process.env.WIND_TUNNEL_WORKER_IMAGE_DIGEST ?? 'local';
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

type CompiledEnvironment = {
  compiler: string;
  version: string;
  payload: unknown;
  durationMs: number;
  bytes: number;
} | null;

class InfrastructureError extends Error {
  constructor(readonly kind: FailureKind, message: string) {
    super(message);
    this.name = 'InfrastructureError';
  }
}

function failure(error: unknown, fallback: FailureKind = 'unknown') {
  if (error instanceof InfrastructureError) return {kind: error.kind, message: error.message};
  return {kind: fallback, message: error instanceof Error ? error.message : String(error)};
}

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

async function preflight() {
  const checks = [
    ['git', ['--version']],
    ['node', ['--version']],
    ['npm', ['--version']],
    ['npx', ['--version']],
    ['psql', ['--version']],
  ] as const;
  const versions: Record<string, string> = {};
  for (const [binary, args] of checks) {
    let result: ProcessResult;
    try { result = await runProcess(binary, [...args], APP_DIR, 15_000); }
    catch (error) { throw new InfrastructureError('worker_environment', `${binary} is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    if (result.exitCode !== 0) throw new InfrastructureError('worker_environment', `${binary} preflight failed: ${result.stderr || result.stdout}`);
    versions[binary] = result.stdout.trim() || result.stderr.trim();
  }
  const requiredEnv = ['DATABASE_URL', 'WIND_TUNNEL_S3_BUCKET', 'WIND_TUNNEL_S3_ENDPOINT', 'WIND_TUNNEL_S3_ACCESS_KEY', 'WIND_TUNNEL_S3_SECRET_KEY'];
  const missing = requiredEnv.filter(name => !process.env[name]);
  if (missing.length) throw new InfrastructureError('worker_environment', `Missing worker configuration: ${missing.join(', ')}`);
  return versions;
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

function buildPrompt(task: string, environment: EnvironmentSpec, compiled: CompiledEnvironment) {
  const common = [
    'Complete the requested repository change.',
    'Do not weaken tests, lint rules, policies, evidence contracts, or architectural constraints.',
    'Use the repository tools available to you and leave the worktree with the implementation applied.',
    '',
    'TASK:',
    task.trim(),
  ].join('\n');
  if (!compiled) return common;
  return [
    common,
    '',
    `COMPILED ENVIRONMENT: ${environment.compiler}@${environment.version}`,
    'A task-specific environment projection is available at .nazare/task.json.',
    'Treat it as the authoritative starting boundary for source files, dependencies, policies, bindings, evidence, and invariants.',
    'Stay inside that projected neighborhood unless source evidence or verification requires expansion.',
  ].join('\n');
}

async function prepareSource(run: RunState) {
  if (run.spec.evaluator.githubSha !== EVALUATOR_SHA) {
    throw new InfrastructureError('worker_environment', `Evaluator mismatch: run=${run.spec.evaluator.githubSha} worker=${EVALUATOR_SHA}`);
  }
  if (run.spec.execution?.workerImageDigest && run.spec.execution.workerImageDigest !== WORKER_IMAGE_DIGEST) {
    throw new InfrastructureError('worker_environment', `Worker image mismatch: run=${run.spec.execution.workerImageDigest} worker=${WORKER_IMAGE_DIGEST}`);
  }
  if (run.spec.agent.package && run.spec.agent.package !== PI_PACKAGE) {
    throw new InfrastructureError('worker_environment', `Pi package mismatch: run=${run.spec.agent.package} worker=${PI_PACKAGE}`);
  }

  const experimentRaw = await readFile(path.join(APP_DIR, run.spec.experiment.path), 'utf8');
  const taskRaw = await readFile(path.join(APP_DIR, run.spec.task.path), 'utf8');
  if (sha256(experimentRaw) !== run.spec.evaluator.experimentDigest) throw new InfrastructureError('worker_environment', 'Experiment digest does not match frozen RunSpec');
  if (sha256(taskRaw) !== run.spec.evaluator.taskDigest) throw new InfrastructureError('worker_environment', 'Task digest does not match frozen RunSpec');
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
  if (init.exitCode !== 0) throw new InfrastructureError('source_checkout', `Subject checkout failed: ${init.stderr || init.stdout}`);

  const head = await runShell('git rev-parse HEAD', sourceDir, 30_000);
  if (head.exitCode !== 0) throw new InfrastructureError('source_checkout', head.stderr || head.stdout);
  const baselineCommit = head.stdout.trim();
  if (baselineCommit !== run.spec.subject.githubSha) {
    throw new InfrastructureError('source_checkout', `Subject SHA mismatch after checkout: expected=${run.spec.subject.githubSha} actual=${baselineCommit}`);
  }

  return {root, sourceDir, baselineCommit, experiment, task: taskRaw};
}

async function createWorktree(sourceDir: string, root: string, baselineCommit: string, arm: Arm) {
  const safeArm = arm.replace(/[^A-Za-z0-9._-]/g, '_');
  const worktree = path.join(root, 'arms', safeArm);
  await mkdir(path.dirname(worktree), {recursive: true});
  const add = await runShell(`git worktree add --detach ${JSON.stringify(worktree)} ${JSON.stringify(baselineCommit)}`, sourceDir, 60_000);
  if (add.exitCode !== 0) throw new InfrastructureError('source_checkout', add.stderr || add.stdout);
  const install = await runShell('npm ci', worktree, 20 * 60 * 1000);
  if (install.exitCode !== 0) throw new InfrastructureError('dependency_install', `Subject dependency install failed for ${arm}: ${install.stderr || install.stdout}`);
  return worktree;
}

async function removeWorktree(sourceDir: string, worktree: string) {
  await runShell(`git worktree remove --force ${JSON.stringify(worktree)}`, sourceDir, 60_000);
  await rm(worktree, {recursive: true, force: true});
}

async function compileEnvironment(worktree: string, environment: EnvironmentSpec): Promise<CompiledEnvironment> {
  if (environment.compiler === 'none') return null;
  if (environment.compiler !== 'nazare') throw new InfrastructureError('environment_compile', `Unsupported environment compiler: ${environment.compiler}`);
  const capabilityId = String(environment.config?.capabilityId ?? '');
  const requestedChange = String(environment.config?.requestedChange ?? '');
  if (!capabilityId || !requestedChange) throw new InfrastructureError('environment_compile', `Nazare environment ${environment.version} requires capabilityId and requestedChange config`);
  await mkdir(path.join(worktree, '.nazare'), {recursive: true});
  const command = `npm run nazare:registry -- compile ${JSON.stringify(capabilityId)} ${JSON.stringify(requestedChange)}`;
  const result = await runShell(command, worktree, 60_000);
  if (result.exitCode !== 0) throw new InfrastructureError('environment_compile', `Nazare compile failed: ${result.stderr || result.stdout}`);
  const jsonStart = result.stdout.indexOf('{');
  if (jsonStart < 0) throw new InfrastructureError('environment_compile', 'Nazare compile did not return JSON');
  let projection: unknown;
  try { projection = JSON.parse(result.stdout.slice(jsonStart)); }
  catch (error) { throw new InfrastructureError('environment_compile', `Nazare compile returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const serialized = JSON.stringify(projection, null, 2);
  await writeFile(path.join(worktree, '.nazare', 'task.json'), serialized);
  return {compiler: environment.compiler, version: environment.version, payload: projection, durationMs: result.durationMs, bytes: Buffer.byteLength(serialized)};
}

async function collectDiff(worktree: string, baselineCommit: string) {
  const patch = await runShell(`git diff --no-ext-diff --binary ${JSON.stringify(baselineCommit)} -- . ':(exclude).nazare/task.json'`, worktree, 60_000);
  if (patch.exitCode !== 0) throw new InfrastructureError('unknown', patch.stderr || patch.stdout);
  const changed = await runShell(`git diff --name-only ${JSON.stringify(baselineCommit)} -- . ':(exclude).nazare/task.json'`, worktree, 60_000);
  if (changed.exitCode !== 0) throw new InfrastructureError('unknown', changed.stderr || changed.stdout);
  return {patch: patch.stdout, changedFiles: changed.stdout.split('\n').map(item => item.trim()).filter(Boolean)};
}

async function executeVerification(run: RunState, arm: Arm, worktree: string) {
  const results: VerificationResult[] = [];
  let stdout = '';
  let stderr = '';
  for (const check of run.spec.verification) {
    let result: ProcessResult;
    try { result = await runShell(check.command, worktree, check.timeoutMs); }
    catch (error) { throw new InfrastructureError('verification_infrastructure', `Could not execute verifier ${check.id}: ${error instanceof Error ? error.message : String(error)}`); }
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
      workerImageDigest: WORKER_IMAGE_DIGEST,
      workspaceBaselineCommit: prepared.baselineCommit,
      workerId: WORKER_ID,
    }});
    await mutate(current => ({...current, failureKind: null, arms: Object.fromEntries(Object.entries(current.arms).map(([name, arm]) => [name, {...arm, workspaceBaselineCommit: prepared.baselineCommit}]))}));

    const runArm = async (arm: Arm) => {
      const startedAt = new Date().toISOString();
      let worktree = '';
      try {
        const environment = state.spec.environments?.[arm];
        if (!environment) throw new InfrastructureError('environment_compile', `RunSpec has no environment definition for arm ${arm}`);
        await mutate(current => ({...current, arms: {...current.arms, [arm]: {...current.arms[arm], status: 'preparing', startedAt, error: null, failureKind: null}}}), {runId: state.runId, type: 'arm.preparing', arm, at: startedAt, data: {environment}});
        worktree = await createWorktree(prepared.sourceDir, prepared.root, prepared.baselineCommit, arm);
        const compiled = await compileEnvironment(worktree, environment);
        if (compiled) await putArtifact({runId: state.runId, arm, type: 'environment.compiled', name: 'compiled-environment.json', mediaType: 'application/json', content: JSON.stringify(compiled, null, 2)});
        const prompt = buildPrompt(prepared.task, environment, compiled);
        await putArtifact({runId: state.runId, arm, type: 'agent.prompt', name: 'prompt.txt', mediaType: 'text/plain', content: prompt});

        await mutate(current => ({...current, arms: {...current.arms, [arm]: {...current.arms[arm], status: 'running'}}}), {runId: state.runId, type: 'agent.started', arm, at: new Date().toISOString()});
        let agent: Awaited<ReturnType<typeof runPi>>;
        try {
          agent = await runPi({
            cwd: worktree,
            prompt,
            provider: state.spec.agent.provider ?? undefined,
            model: state.spec.agent.model ?? undefined,
            thinking: state.spec.agent.thinking ?? undefined,
            timeoutMs: state.spec.agent.timeoutMs,
          });
        } catch (error) {
          throw new InfrastructureError('agent_harness', `Pi could not start: ${error instanceof Error ? error.message : String(error)}`);
        }
        await Promise.all([
          putArtifact({runId: state.runId, arm, type: 'pi.transcript', name: 'pi.jsonl', mediaType: 'application/x-ndjson', content: agent.stdout}),
          putArtifact({runId: state.runId, arm, type: 'pi.stderr', name: 'pi.stderr.log', mediaType: 'text/plain', content: agent.stderr}),
        ]);
        if (agent.exitCode !== 0 || agent.timedOut) throw new InfrastructureError('agent_harness', agent.timedOut ? 'Pi execution timed out' : `Pi exited with code ${agent.exitCode}: ${agent.stderr.slice(-4000)}`);

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
            workerImageDigest: WORKER_IMAGE_DIGEST,
            environment,
            agentDurationMs: agent.durationMs,
            patchBytes: Buffer.byteLength(diff.patch),
            filesChanged: diff.changedFiles.length,
            environmentCompileDurationMs: compiled?.durationMs ?? 0,
            environmentContextBytes: compiled?.bytes ?? 0,
            verificationDurationMs: verification.reduce((sum, item) => sum + item.durationMs, 0),
          }, null, 2),
        });
        await mutate(current => ({...current, arms: {...current.arms, [arm]: {...current.arms[arm], status: 'completed', outcome: requiredPassed ? 'pass' : 'fail', finishedAt, error: null, failureKind: null}}}), {runId: state.runId, type: 'arm.completed', arm, at: finishedAt, data: {outcome: requiredPassed ? 'pass' : 'fail'}});
      } catch (error) {
        const problem = failure(error);
        const finishedAt = new Date().toISOString();
        try { await putArtifact({runId: state.runId, arm, type: 'arm.error', name: 'error.txt', mediaType: 'text/plain', content: `${problem.kind}: ${problem.message}`}); } catch {}
        await mutate(current => ({...current, error: current.error ?? problem.message, failureKind: current.failureKind ?? problem.kind, arms: {...current.arms, [arm]: {...current.arms[arm], status: 'failed', outcome: null, finishedAt, error: problem.message, failureKind: problem.kind}}}), {runId: state.runId, type: 'arm.failed', arm, at: finishedAt, data: {error: problem.message, failureKind: problem.kind}});
      } finally {
        if (worktree) await removeWorktree(prepared.sourceDir, worktree);
      }
    };

    await Promise.all(state.spec.arms.map(runArm));
    await persistChain;
    if (state.status === 'completed') await appendEvent({runId: state.runId, type: 'run.completed', at: new Date().toISOString(), data: {outcome: state.outcome}});
    else if (state.status === 'failed') await appendEvent({runId: state.runId, type: 'run.failed', at: new Date().toISOString(), data: {error: state.error, failureKind: state.failureKind}});
  } catch (error) {
    const problem = failure(error, 'worker_environment');
    state = await saveRunState({...state, status: 'failed', outcome: null, error: problem.message, failureKind: problem.kind, finishedAt: new Date().toISOString()});
    await appendEvent({runId: state.runId, type: 'run.failed', at: new Date().toISOString(), data: {error: problem.message, failureKind: problem.kind}});
  } finally {
    clearInterval(heartbeat);
    if (root) await rm(root, {recursive: true, force: true});
  }
}

async function main() {
  if (EVALUATOR_SHA === 'local' && process.env.RAILWAY_ENVIRONMENT) {
    throw new InfrastructureError('worker_environment', 'RAILWAY_GIT_COMMIT_SHA is required in Railway; refusing unverifiable evaluator deployment');
  }
  const versions = await preflight();
  await ensureSchema();
  console.log(`Nazare Wind Tunnel worker ${WORKER_ID}`);
  console.log(`Evaluator SHA: ${EVALUATOR_SHA}`);
  console.log(`Worker image: ${WORKER_IMAGE_DIGEST}`);
  console.log(`Preflight: ${JSON.stringify(versions)}`);
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