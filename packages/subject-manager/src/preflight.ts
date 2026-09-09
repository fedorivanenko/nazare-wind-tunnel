import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {runSubjectProcess} from './index.js';

export type SubjectPreflight = {
  ok: boolean;
  repository: string;
  cwd: string;
  expectedSha: string;
  headSha: string | null;
  shaMatches: boolean;
  lockfileExists: boolean;
  lockfileHash: string | null;
  nodeModulesExists: boolean;
  nodeVersion: string | null;
  pnpmVersion: string | null;
  experimentExists: boolean;
  taskExists: boolean;
  piBinary: string;
  piVersion: string | null;
  piAvailable: boolean;
  providerConfigured: boolean;
  failures: string[];
};

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

async function commandVersion(file: string, args: string[], cwd: string) {
  try {
    const result = await runSubjectProcess(file, args, cwd, 10_000);
    if (result.exitCode !== 0 || result.timedOut) return null;
    return (result.stdout || result.stderr).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

export async function inspectSubjectReadiness(input: {
  repository: string;
  cwd: string;
  expectedSha: string;
  experimentPath: string;
  taskPath: string;
  provider?: string | null;
}) : Promise<SubjectPreflight> {
  const {repository,cwd,expectedSha,experimentPath,taskPath,provider} = input;
  const failures: string[] = [];
  const gitDirExists = existsSync(path.join(cwd,'.git'));
  const lockfilePath = path.join(cwd,'pnpm-lock.yaml');
  const lockfileExists = existsSync(lockfilePath);
  const nodeModulesExists = existsSync(path.join(cwd,'node_modules'));
  const experimentExists = existsSync(path.resolve(cwd,experimentPath));
  const taskExists = existsSync(taskPath);
  let headSha: string | null = null;
  if (gitDirExists) {
    const head = await runSubjectProcess('git',['rev-parse','HEAD'],cwd,10_000).catch(() => null);
    if (head && head.exitCode === 0 && !head.timedOut) headSha = head.stdout.trim() || null;
  }
  const shaMatches = Boolean(headSha && headSha.toLowerCase() === expectedSha.toLowerCase());
  const lockfileHash = lockfileExists ? sha256(await readFile(lockfilePath)) : null;
  const [nodeVersion,pnpmVersion] = await Promise.all([
    commandVersion('node',['--version'],cwd),
    commandVersion('pnpm',['--version'],cwd),
  ]);
  const piBinary = process.env.WIND_TUNNEL_PI_BIN ?? 'pi';
  const piVersion = await commandVersion(piBinary,['--version'],cwd);
  const piAvailable = Boolean(piVersion);

  const normalizedProvider = String(provider ?? '').toLowerCase();
  const providerConfigured = normalizedProvider.includes('gateway')
    ? Boolean(process.env.AI_GATEWAY_API_KEY)
    : Boolean(
        process.env.AI_GATEWAY_API_KEY ||
        process.env.OPENAI_API_KEY ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.GROQ_API_KEY
      );

  if (!gitDirExists) failures.push('git checkout missing');
  if (!shaMatches) failures.push(`HEAD ${headSha ?? 'missing'} does not match ${expectedSha}`);
  if (!lockfileExists) failures.push('pnpm-lock.yaml missing');
  if (!nodeModulesExists) failures.push('node_modules missing');
  if (!nodeVersion) failures.push('node unavailable');
  if (!pnpmVersion) failures.push('pnpm unavailable');
  if (!experimentExists) failures.push(`experiment missing: ${experimentPath}`);
  if (!taskExists) failures.push(`task missing: ${path.relative(cwd,taskPath)}`);
  if (!piAvailable) failures.push(`Pi unavailable: ${piBinary}`);
  if (!providerConfigured) failures.push(`provider credentials not detected for ${provider || 'configured provider'}`);

  return {
    ok: failures.length === 0,
    repository,cwd,expectedSha,headSha,shaMatches,
    lockfileExists,lockfileHash,nodeModulesExists,nodeVersion,pnpmVersion,
    experimentExists,taskExists,piBinary,piVersion,piAvailable,providerConfigured,failures,
  };
}
