import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

const WORKSPACE_ROOT = process.env.WIND_TUNNEL_WORKSPACE ?? '/workspace';
const REPOS_ROOT = path.join(WORKSPACE_ROOT, 'repos');
const STATE_ROOT = path.join(WORKSPACE_ROOT, '.wind-tunnel', 'subjects');
const PNPM_STORE_DIR = process.env.WIND_TUNNEL_PNPM_STORE ?? path.join(WORKSPACE_ROOT, 'pnpm-store');

type ProcessResult = {exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean};

type SubjectState = {
  repository: string;
  lockfileHash: string | null;
  installedAt: string | null;
  lastUsedAt: string;
};

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function assertRepository(repository: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`Invalid GitHub repository: ${repository}`);
}

async function run(file: string, args: string[], cwd: string, timeoutMs = 10 * 60 * 1000): Promise<ProcessResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {cwd, env: process.env});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-5_000_000); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-5_000_000); });
    child.on('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.on('close', exitCode => {
      clearTimeout(timer);
      resolve({exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut});
    });
  });
}

async function must(result: ProcessResult, label: string) {
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`${label}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  return result;
}

function subjectPath(repository: string) {
  assertRepository(repository);
  return path.join(REPOS_ROOT, ...repository.split('/'));
}

function subjectStatePath(repository: string) {
  return path.join(STATE_ROOT, `${sha256(repository)}.json`);
}

async function readState(repository: string): Promise<SubjectState | null> {
  try { return JSON.parse(await readFile(subjectStatePath(repository), 'utf8')) as SubjectState; }
  catch { return null; }
}

async function writeState(state: SubjectState) {
  await mkdir(STATE_ROOT, {recursive: true});
  await writeFile(subjectStatePath(state.repository), JSON.stringify(state, null, 2));
}

export async function ensureSubject(repository: string, githubSha: string) {
  assertRepository(repository);
  if (!/^[0-9a-f]{40}$/i.test(githubSha)) throw new Error(`sourceSha must be a full 40-character commit SHA`);
  const cwd = subjectPath(repository);
  await mkdir(path.dirname(cwd), {recursive: true});

  if (!existsSync(path.join(cwd, '.git'))) {
    await must(await run('git', ['clone', '--no-checkout', `https://github.com/${repository}.git`, cwd], path.dirname(cwd)), 'git clone');
  }

  await must(await run('git', ['fetch', '--prune', 'origin'], cwd), 'git fetch');
  await must(await run('git', ['reset', '--hard', githubSha], cwd, 60_000), 'git reset');
  await must(await run('git', ['clean', '-fdx', '-e', 'node_modules/'], cwd, 60_000), 'git clean');
  const head = await must(await run('git', ['rev-parse', 'HEAD'], cwd, 30_000), 'git rev-parse');
  if (head.stdout.trim().toLowerCase() !== githubSha.toLowerCase()) throw new Error(`Subject SHA mismatch: ${head.stdout.trim()} != ${githubSha}`);

  await writeState({
    repository,
    lockfileHash: (await readState(repository))?.lockfileHash ?? null,
    installedAt: (await readState(repository))?.installedAt ?? null,
    lastUsedAt: new Date().toISOString(),
  });
  return {repository, githubSha, cwd};
}

export async function ensureDependencies(repository: string) {
  const cwd = subjectPath(repository);
  const lockfile = path.join(cwd, 'pnpm-lock.yaml');
  if (!existsSync(lockfile)) throw new Error(`Subject ${repository} must contain pnpm-lock.yaml`);
  const lockfileHash = sha256(await readFile(lockfile));
  const previous = await readState(repository);
  const nodeModulesExists = existsSync(path.join(cwd, 'node_modules'));

  if (nodeModulesExists && previous?.lockfileHash === lockfileHash) {
    await writeState({...previous, lastUsedAt: new Date().toISOString()});
    return {installed: false, reason: 'lockfile-unchanged', lockfileHash};
  }

  await mkdir(PNPM_STORE_DIR, {recursive: true});
  const result = await must(await run('pnpm', ['install', '--frozen-lockfile', '--store-dir', PNPM_STORE_DIR], cwd, 20 * 60 * 1000), 'pnpm install');
  await writeState({repository, lockfileHash, installedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString()});
  return {installed: true, reason: nodeModulesExists ? 'lockfile-changed' : 'dependencies-missing', lockfileHash, durationMs: result.durationMs};
}

export async function cleanSubject(repository: string) {
  const cwd = subjectPath(repository);
  if (!existsSync(path.join(cwd, '.git'))) return;
  await run('git', ['reset', '--hard', 'HEAD'], cwd, 60_000);
  await run('git', ['clean', '-fdx', '-e', 'node_modules/'], cwd, 60_000);
  await rm(path.join(cwd, '.nazare', 'task.json'), {force: true});
}

export function getSubjectPath(repository: string) {
  return subjectPath(repository);
}
