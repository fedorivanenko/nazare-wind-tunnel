import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {cp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';

const APP_DIR = process.env.WIND_TUNNEL_APP_DIR ?? '/app';
const ROOT = process.env.WIND_TUNNEL_WORKSPACE ?? '/workspace';
const TARGET_DIR = path.join(ROOT, 'target');
const ENV_DIR = path.join(ROOT, 'environment');
const RUNS_DIR = path.join(ROOT, 'runs');
const TARGET_REPO = process.env.WIND_TUNNEL_TARGET_REPO ?? 'fedorivanenko/nazare-hydrogen';
const TARGET_SHA = process.env.WIND_TUNNEL_TARGET_SHA ?? '';
const ENV_REPO = process.env.WIND_TUNNEL_ENV_REPO ?? 'fedorivanenko/nazare-wind-tunnel';
const DEFAULT_ENV_REF = process.env.WIND_TUNNEL_ENV_REF ?? 'env/current';
const PI_PACKAGE = process.env.WIND_TUNNEL_PI_PACKAGE ?? '@earendil-works/pi-coding-agent@0.85.1';
const BENCHMARK_CONFIG = process.env.WIND_TUNNEL_BENCHMARK_CONFIG ?? path.join(APP_DIR, 'benchmark', 'config.json');

type Budget = {maxSeconds: number; maxToolCalls: number; maxTotalTokens: number | null};
type Checker = {id: string; command: string; timeoutSeconds?: number; required?: boolean};
type BenchmarkConfig = {
  taskFile: string;
  environmentPromptFile?: string;
  model: {provider?: string; id: string; thinking?: string};
  budget: Budget;
  tools?: string[];
  checkers: Checker[];
};

type Usage = {toolCalls: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null};
type Proc = {exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number};
export type RunSummary = {
  runId: string;
  environmentRef: string;
  environmentSha: string;
  targetSha: string;
  result: 'pass' | 'fail' | 'budget_exceeded' | 'error';
  startedAt: string;
  finishedAt: string;
  wallClockMs: number;
  usage: Usage;
  changedFiles: string[];
  patchBytes: number;
  verification: Array<{id: string; command: string; required: boolean; passed: boolean; exitCode: number | null; timedOut: boolean; durationMs: number}>;
  error?: string;
};

function repoUrl(repo: string) { return `https://github.com/${repo}.git`; }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }

async function exec(file: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<Proc> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {cwd, env: process.env});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', c => { stdout += c.toString(); });
    child.stderr?.on('data', c => { stderr += c.toString(); });
    child.on('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    child.on('close', exitCode => {
      clearTimeout(timer);
      resolve({exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started});
    });
  });
}

function sh(command: string, cwd: string, timeoutMs?: number) {
  return exec('/bin/sh', ['-lc', command], cwd, timeoutMs);
}

async function ensureClone(dir: string, repo: string) {
  await mkdir(ROOT, {recursive: true});
  if (!existsSync(path.join(dir, '.git'))) {
    await rm(dir, {recursive: true, force: true});
    const clone = await exec('git', ['clone', repoUrl(repo), dir], ROOT, 5 * 60_000);
    if (clone.exitCode !== 0) throw new Error(`clone ${repo} failed: ${clone.stderr || clone.stdout}`);
  }
  const remote = await exec('git', ['remote', 'set-url', 'origin', repoUrl(repo)], dir);
  if (remote.exitCode !== 0) throw new Error(remote.stderr || remote.stdout);
}

async function resolveRef(dir: string, ref: string) {
  const fetch = await exec('git', ['fetch', '--prune', 'origin'], dir, 2 * 60_000);
  if (fetch.exitCode !== 0) throw new Error(fetch.stderr || fetch.stdout);
  for (const candidate of [ref, `origin/${ref}`]) {
    const r = await exec('git', ['rev-parse', `${candidate}^{commit}`], dir, 30_000);
    if (r.exitCode === 0) return r.stdout.trim();
  }
  throw new Error(`cannot resolve environment ref ${ref}`);
}

async function resetTarget() {
  if (!/^[a-f0-9]{40}$/i.test(TARGET_SHA)) throw new Error('WIND_TUNNEL_TARGET_SHA must be a frozen 40-character commit SHA');
  await ensureClone(TARGET_DIR, TARGET_REPO);
  const fetch = await exec('git', ['fetch', '--depth', '1', 'origin', TARGET_SHA], TARGET_DIR, 3 * 60_000);
  if (fetch.exitCode !== 0) throw new Error(`target fetch failed: ${fetch.stderr || fetch.stdout}`);
  for (const args of [['reset', '--hard', TARGET_SHA], ['clean', '-fd', '-e', 'node_modules']]) {
    const result = await exec('git', args, TARGET_DIR, 60_000);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  }
  const head = await exec('git', ['rev-parse', 'HEAD'], TARGET_DIR, 30_000);
  if (head.stdout.trim() !== TARGET_SHA) throw new Error(`target SHA mismatch: ${head.stdout.trim()}`);
}

async function ensureTargetDependencies() {
  const lockPath = path.join(TARGET_DIR, 'package-lock.json');
  const marker = path.join(TARGET_DIR, 'node_modules', '.wind-tunnel-lock-sha');
  const digest = sha256(await readFile(lockPath));
  let current = '';
  try { current = (await readFile(marker, 'utf8')).trim(); } catch {}
  if (current === digest && existsSync(path.join(TARGET_DIR, 'node_modules'))) return;
  const install = await sh('npm ci', TARGET_DIR, 20 * 60_000);
  if (install.exitCode !== 0) throw new Error(`target npm ci failed: ${install.stderr || install.stdout}`);
  await writeFile(marker, `${digest}\n`);
}

async function checkoutEnvironment(ref: string) {
  await ensureClone(ENV_DIR, ENV_REPO);
  const sha = await resolveRef(ENV_DIR, ref);
  const checkout = await exec('git', ['checkout', '--detach', '--force', sha], ENV_DIR, 60_000);
  if (checkout.exitCode !== 0) throw new Error(checkout.stderr || checkout.stdout);
  const clean = await exec('git', ['clean', '-fd'], ENV_DIR, 60_000);
  if (clean.exitCode !== 0) throw new Error(clean.stderr || clean.stdout);
  if (!existsSync(path.join(ENV_DIR, 'environment'))) throw new Error(`${ref} has no environment/ directory`);
  return sha;
}

async function benchmarkConfig(): Promise<BenchmarkConfig> {
  return JSON.parse(await readFile(BENCHMARK_CONFIG, 'utf8')) as BenchmarkConfig;
}

async function projectEnvironment() {
  const destination = path.join(TARGET_DIR, '.nazare');
  await rm(destination, {recursive: true, force: true});
  await cp(path.join(ENV_DIR, 'environment'), destination, {recursive: true});
}

async function buildPrompt(config: BenchmarkConfig) {
  const task = await readFile(path.resolve(APP_DIR, config.taskFile), 'utf8');
  const environmentPrompt = await readFile(path.join(TARGET_DIR, '.nazare', config.environmentPromptFile ?? 'prompt.md'), 'utf8');
  return `${environmentPrompt.trim()}\n\nThe experiment environment is available read-only by convention under .nazare/.\nDo not modify .nazare/. Modify only the target repository.\n\nTASK:\n${task.trim()}\n`;
}

function inspectEvent(event: unknown, usage: Usage) {
  if (!event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  const type = String(e.type ?? '');
  if (/tool/i.test(type) && /(call|execution|start)/i.test(type)) usage.toolCalls += 1;
  const u = (e.usage && typeof e.usage === 'object' ? e.usage : e) as Record<string, unknown>;
  const input = Number(u.inputTokens ?? u.input_tokens ?? NaN);
  const output = Number(u.outputTokens ?? u.output_tokens ?? NaN);
  const total = Number(u.totalTokens ?? u.total_tokens ?? NaN);
  if (Number.isFinite(input)) usage.inputTokens = Math.max(usage.inputTokens ?? 0, input);
  if (Number.isFinite(output)) usage.outputTokens = Math.max(usage.outputTokens ?? 0, output);
  if (Number.isFinite(total)) usage.totalTokens = Math.max(usage.totalTokens ?? 0, total);
}

async function runPi(prompt: string, config: BenchmarkConfig) {
  const usage: Usage = {toolCalls: 0, inputTokens: null, outputTokens: null, totalTokens: null};
  const args = ['--yes', PI_PACKAGE, '--mode', 'json', '-p', '--no-session', '--no-approve'];
  if (config.model.provider) args.push('--provider', config.model.provider);
  args.push('--model', config.model.id);
  if (config.model.thinking) args.push('--thinking', config.model.thinking);
  if (config.tools?.length) args.push('--tools', config.tools.join(','));
  args.push('--', prompt);

  const started = Date.now();
  return await new Promise<{exitCode: number | null; stdout: string; stderr: string; durationMs: number; budgetExceeded: boolean; budgetReason: string | null; usage: Usage}>((resolve, reject) => {
    const child = spawn('npx', args, {cwd: TARGET_DIR, env: {...process.env, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0'}});
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let budgetExceeded = false;
    let budgetReason: string | null = null;
    const stop = (reason: string) => {
      if (budgetExceeded) return;
      budgetExceeded = true;
      budgetReason = reason;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    };
    child.stdout?.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      buffer += text;
      let i = buffer.indexOf('\n');
      while (i >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) {
          try { inspectEvent(JSON.parse(line), usage); } catch {}
          if (usage.toolCalls > config.budget.maxToolCalls) stop(`tool_calls>${config.budget.maxToolCalls}`);
          if (config.budget.maxTotalTokens && usage.totalTokens && usage.totalTokens > config.budget.maxTotalTokens) stop(`tokens>${config.budget.maxTotalTokens}`);
        }
        i = buffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', c => { stderr += c.toString(); });
    child.on('error', reject);
    const timer = setTimeout(() => stop(`time>${config.budget.maxSeconds}s`), Math.max(1, config.budget.maxSeconds) * 1000);
    child.on('close', exitCode => {
      clearTimeout(timer);
      resolve({exitCode, stdout, stderr, durationMs: Date.now() - started, budgetExceeded, budgetReason, usage});
    });
  });
}

async function gitDiff() {
  const patch = await sh(`git diff --no-ext-diff --binary ${TARGET_SHA} -- . ':(exclude).nazare/**'`, TARGET_DIR, 60_000);
  const names = await sh(`git diff --name-only ${TARGET_SHA} -- . ':(exclude).nazare/**'`, TARGET_DIR, 60_000);
  if (patch.exitCode !== 0 || names.exitCode !== 0) throw new Error(patch.stderr || names.stderr);
  return {patch: patch.stdout, changedFiles: names.stdout.split('\n').map(x => x.trim()).filter(Boolean)};
}

async function verify(checkers: Checker[]) {
  const results = [];
  for (const checker of checkers) {
    const r = await sh(checker.command, TARGET_DIR, (checker.timeoutSeconds ?? 120) * 1000);
    results.push({id: checker.id, command: checker.command, required: checker.required !== false, passed: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdout: r.stdout, stderr: r.stderr});
  }
  return results;
}

export async function prepareWorkspace() {
  await mkdir(RUNS_DIR, {recursive: true});
  await ensureClone(ENV_DIR, ENV_REPO);
  await resetTarget();
  await ensureTargetDependencies();
  return workspaceStatus();
}

export async function workspaceStatus() {
  const targetHead = existsSync(path.join(TARGET_DIR, '.git')) ? (await exec('git', ['rev-parse', 'HEAD'], TARGET_DIR, 30_000)).stdout.trim() : null;
  const environmentHead = existsSync(path.join(ENV_DIR, '.git')) ? (await exec('git', ['rev-parse', 'HEAD'], ENV_DIR, 30_000)).stdout.trim() : null;
  const config = existsSync(BENCHMARK_CONFIG) ? await benchmarkConfig() : null;
  return {workspace: ROOT, target: {repository: TARGET_REPO, frozenSha: TARGET_SHA || null, checkedOutSha: targetHead, prepared: existsSync(path.join(TARGET_DIR, 'node_modules'))}, environment: {repository: ENV_REPO, defaultRef: DEFAULT_ENV_REF, checkedOutSha: environmentHead}, benchmark: config, runsDir: RUNS_DIR};
}

export async function runTest(environmentRef = DEFAULT_ENV_REF): Promise<RunSummary> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(RUNS_DIR, runId);
  await mkdir(runDir, {recursive: true});
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let environmentSha = '';
  try {
    const config = await benchmarkConfig();
    environmentSha = await checkoutEnvironment(environmentRef);
    await resetTarget();
    await ensureTargetDependencies();
    await projectEnvironment();
    const prompt = await buildPrompt(config);
    await writeFile(path.join(runDir, 'prompt.txt'), prompt);
    await writeFile(path.join(runDir, 'environment.json'), JSON.stringify({ref: environmentRef, sha: environmentSha}, null, 2));
    await writeFile(path.join(runDir, 'benchmark.json'), JSON.stringify(config, null, 2));

    const agent = await runPi(prompt, config);
    await writeFile(path.join(runDir, 'transcript.jsonl'), agent.stdout);
    await writeFile(path.join(runDir, 'pi.stderr.log'), agent.stderr);
    const diff = await gitDiff();
    await writeFile(path.join(runDir, 'patch.diff'), diff.patch);
    await writeFile(path.join(runDir, 'changed-files.json'), JSON.stringify(diff.changedFiles, null, 2));

    const checks = await verify(config.checkers);
    await writeFile(path.join(runDir, 'verification.json'), JSON.stringify(checks, null, 2));
    for (const check of checks) {
      await writeFile(path.join(runDir, `checker-${check.id}.stdout.log`), check.stdout);
      await writeFile(path.join(runDir, `checker-${check.id}.stderr.log`), check.stderr);
    }
    const requiredPassed = checks.filter(x => x.required).every(x => x.passed);
    const result: RunSummary['result'] = agent.budgetExceeded ? 'budget_exceeded' : agent.exitCode === 0 && requiredPassed ? 'pass' : 'fail';
    const summary: RunSummary = {
      runId, environmentRef, environmentSha, targetSha: TARGET_SHA, result, startedAt, finishedAt: new Date().toISOString(), wallClockMs: Date.now() - started,
      usage: agent.usage, changedFiles: diff.changedFiles, patchBytes: Buffer.byteLength(diff.patch),
      verification: checks.map(({stdout: _o, stderr: _e, ...rest}) => rest),
      ...(agent.budgetReason ? {error: agent.budgetReason} : {}),
    };
    await writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    return summary;
  } catch (error) {
    const summary: RunSummary = {runId, environmentRef, environmentSha, targetSha: TARGET_SHA, result: 'error', startedAt, finishedAt: new Date().toISOString(), wallClockMs: Date.now() - started, usage: {toolCalls: 0, inputTokens: null, outputTokens: null, totalTokens: null}, changedFiles: [], patchBytes: 0, verification: [], error: error instanceof Error ? error.message : String(error)};
    await writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    return summary;
  }
}

export async function listRuns(limit = 20) {
  if (!existsSync(RUNS_DIR)) return [];
  const dirs = (await readdir(RUNS_DIR)).sort().reverse().slice(0, Math.max(1, Math.min(limit, 100)));
  const runs = [];
  for (const dir of dirs) {
    try { runs.push(JSON.parse(await readFile(path.join(RUNS_DIR, dir, 'summary.json'), 'utf8'))); } catch {}
  }
  return runs;
}

export async function getRun(runId: string) {
  const safe = path.basename(runId);
  if (safe !== runId) throw new Error('invalid run id');
  const dir = path.join(RUNS_DIR, safe);
  const summary = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8'));
  const artifacts: Record<string, string> = {};
  for (const file of await readdir(dir)) {
    if (!/\.(json|txt|log|diff|jsonl)$/.test(file)) continue;
    const full = path.join(dir, file);
    if ((await stat(full)).size <= 400_000) artifacts[file] = await readFile(full, 'utf8');
  }
  return {summary, artifacts};
}
