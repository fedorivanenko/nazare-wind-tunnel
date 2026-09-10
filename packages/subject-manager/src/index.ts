import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';

const WORKSPACE_ROOT = process.env.WIND_TUNNEL_WORKSPACE ?? '/workspace';
const REPOS_ROOT = path.join(WORKSPACE_ROOT, 'repos');
const STATE_ROOT = path.join(WORKSPACE_ROOT, '.wind-tunnel', 'subjects');
const PNPM_STORE_DIR = process.env.WIND_TUNNEL_PNPM_STORE ?? path.join(WORKSPACE_ROOT, 'pnpm-store');
const RUNS_ROOT = path.join(WORKSPACE_ROOT, 'runs');
const INDEX_ROOT = path.join(WORKSPACE_ROOT, '.wind-tunnel', 'indexes');

type ProcessResult = {exitCode: number | null; stdout: string; stderr: string; stdoutBytes:number; stderrBytes:number; durationMs: number; timedOut: boolean};
type ProcessOptions = {input?:string;env?:NodeJS.ProcessEnv};

export type SubjectProcessObservation = {
  type: 'started' | 'activity' | 'completed' | 'error';
  at: string;
  file: string;
  args: string[];
  pid?: number;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  error?: string;
};

export type SubjectProcessObserver = (observation: SubjectProcessObservation) => void;

type SubjectState = {
  repository: string;
  lockfileHash: string | null;
  installedAt: string | null;
  lastUsedAt: string;
};

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
  dependencyState: 'installed' | 'reused' | 'unknown';
  nodeVersion: string | null;
  pnpmVersion: string | null;
  experimentExists: boolean;
  taskExists: boolean;
  piBinary: string;
  piVersion: string | null;
  piAvailable: boolean;
  providerConfigured: boolean;
  gitMetadataIsolated:boolean;
  failures: string[];
};

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function assertRepository(repository: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`Invalid GitHub repository: ${repository}`);
}

export function subjectRuntimeEnv(extra:NodeJS.ProcessEnv={}):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',LANG:process.env.LANG??'C.UTF-8',LC_ALL:process.env.LC_ALL??'C.UTF-8',CI:'true',HOME:path.join(WORKSPACE_ROOT,'.wind-tunnel','home'),PNPM_HOME:process.env.PNPM_HOME,COREPACK_HOME:process.env.COREPACK_HOME,...extra};
  return Object.fromEntries(Object.entries(env).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
}

function gitRuntimeEnv():NodeJS.ProcessEnv {
  const token=process.env.WIND_TUNNEL_GITHUB_TOKEN;
  if(!token)return subjectRuntimeEnv({GIT_TERMINAL_PROMPT:'0'});
  return subjectRuntimeEnv({GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`});
}

export async function runSubjectProcess(file: string, args: string[], cwd: string, timeoutMs = 10 * 60 * 1000, observer?: SubjectProcessObserver, options:ProcessOptions={}): Promise<ProcessResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {cwd, env:options.env??subjectRuntimeEnv()});
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lastActivityReport = 0;
    let timedOut = false;
    const observe = (observation: Omit<SubjectProcessObservation, 'at' | 'file' | 'args'>) => observer?.({at:new Date().toISOString(),file,args,...observation});
    const reportActivity = () => {
      const now = Date.now();
      if (now - lastActivityReport < 2_000) return;
      lastActivityReport = now;
      observe({type:'activity',pid:child.pid,durationMs:now-started,stdoutBytes,stderrBytes});
    };
    child.on('spawn', () => {observe({type:'started',pid:child.pid});child.stdin?.end(options.input);});
    child.stdout?.on('data', chunk => { const text=chunk.toString();stdoutBytes+=Buffer.byteLength(text);stdout=(stdout+text).slice(-5_000_000);reportActivity(); });
    child.stderr?.on('data', chunk => { const text=chunk.toString();stderrBytes+=Buffer.byteLength(text);stderr=(stderr+text).slice(-5_000_000);reportActivity(); });
    child.on('error', error => {observe({type:'error',pid:child.pid,error:error.message});reject(error);});
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.on('close', exitCode => {
      clearTimeout(timer);
      const durationMs=Date.now()-started;
      observe({type:'completed',pid:child.pid,durationMs,exitCode,timedOut,stdoutBytes,stderrBytes});
      resolve({exitCode, stdout, stderr, stdoutBytes, stderrBytes, durationMs, timedOut});
    });
  });
}

async function must(result: ProcessResult, label: string) {
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`${label}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  return result;
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

export async function ensureSubject(repository: string, githubSha: string, observer?: SubjectProcessObserver) {
  assertRepository(repository);
  if (!/^[0-9a-f]{40}$/i.test(githubSha)) throw new Error('sourceSha must be a full 40-character commit SHA');
  const cwd = subjectPath(repository);const gitEnv=gitRuntimeEnv();
  await mkdir(path.dirname(cwd), {recursive: true});
  await mkdir(path.join(WORKSPACE_ROOT,'.wind-tunnel','home'),{recursive:true});

  if (!existsSync(path.join(cwd, '.git'))) {
    await mkdir(cwd,{recursive:true});
    await must(await runSubjectProcess('git',['init'],cwd,30_000,observer,{env:gitEnv}),'git init');
    await must(await runSubjectProcess('git',['remote','add','origin',`https://github.com/${repository}.git`],cwd,30_000,observer,{env:gitEnv}),'git remote add');
  }

  await must(await runSubjectProcess('git',['fetch','--no-tags','--force','origin',githubSha],cwd,10*60*1000,observer,{env:gitEnv}),'git fetch exact commit');
  await must(await runSubjectProcess('git',['reset','--hard',githubSha],cwd,60_000,observer,{env:gitEnv}),'git reset');
  await must(await runSubjectProcess('git',['clean','-fdx','-e','node_modules/'],cwd,60_000,observer,{env:gitEnv}),'git clean');
  const head=await must(await runSubjectProcess('git',['rev-parse','HEAD'],cwd,30_000,observer,{env:gitEnv}),'git rev-parse');
  if(head.stdout.trim().toLowerCase()!==githubSha.toLowerCase())throw new Error(`Subject SHA mismatch: ${head.stdout.trim()} != ${githubSha}`);

  const previous=await readState(repository);
  await writeState({repository,lockfileHash:previous?.lockfileHash??null,installedAt:previous?.installedAt??null,lastUsedAt:new Date().toISOString()});
  return {repository,githubSha,cwd};
}

export async function ensureDependencies(repository: string, observer?: SubjectProcessObserver) {
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
  const result = await must(await runSubjectProcess('pnpm', ['install', '--frozen-lockfile', '--store-dir', PNPM_STORE_DIR], cwd, 20 * 60 * 1000, observer), 'pnpm install');
  await writeState({repository, lockfileHash, installedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString()});
  return {installed: true, reason: nodeModulesExists ? 'lockfile-changed' : 'dependencies-missing', lockfileHash, durationMs: result.durationMs};
}

function runSubjectPath(runId:string){
  if(!/^[0-9a-f-]{36}$/i.test(runId))throw new Error(`Invalid run ID: ${runId}`);
  return path.join(RUNS_ROOT,runId,'subject');
}

export async function materializeSubject(repository:string,githubSha:string,runId:string,observer?:SubjectProcessObserver){
  const trustedCwd=subjectPath(repository);const cwd=runSubjectPath(runId);const runRoot=path.dirname(cwd);const archive=path.join(runRoot,'subject.tar');
  await rm(runRoot,{recursive:true,force:true});await mkdir(cwd,{recursive:true});
  await must(await runSubjectProcess('git',['archive','--format=tar','--output',archive,githubSha],trustedCwd,60_000,observer),'git archive');
  try{await must(await runSubjectProcess('tar',['-xf',archive,'-C',cwd],trustedCwd,60_000,observer),'extract subject archive');}
  finally{await rm(archive,{force:true});}
  const dependencies=path.join(trustedCwd,'node_modules');
  if(!existsSync(dependencies))throw new Error('Subject dependencies missing before materialization');
  await symlink(dependencies,path.join(cwd,'node_modules'),'dir');
  return {repository,githubSha,cwd,trustedCwd,gitMetadataIsolated:!existsSync(path.join(cwd,'.git'))};
}

export async function captureSubjectChanges(repository:string,githubSha:string,runId:string,observer?:SubjectProcessObserver){
  const trustedCwd=subjectPath(repository);const cwd=runSubjectPath(runId);await mkdir(INDEX_ROOT,{recursive:true});
  const indexPath=path.join(INDEX_ROOT,`${runId}.index`);await rm(indexPath,{force:true});
  const env=subjectRuntimeEnv({GIT_DIR:path.join(trustedCwd,'.git'),GIT_WORK_TREE:cwd,GIT_INDEX_FILE:indexPath});
  try{
    await must(await runSubjectProcess('git',['read-tree',githubSha],cwd,30_000,observer,{env}),'git read-tree');
    await must(await runSubjectProcess('git',['add','-A','--','.',':(exclude)node_modules'],cwd,60_000,observer,{env}),'git add candidate');
    const patch=await must(await runSubjectProcess('git',['diff','--cached','--no-ext-diff','--binary',githubSha,'--','.'],cwd,60_000,observer,{env}),'git diff candidate');
    const changed=await must(await runSubjectProcess('git',['diff','--cached','--name-only',githubSha,'--','.'],cwd,60_000,observer,{env}),'git changed files');
    return {patch:patch.stdout,changedFiles:changed.stdout};
  }finally{await rm(indexPath,{force:true});}
}

export async function cleanRunSubject(runId:string){await rm(path.dirname(runSubjectPath(runId)),{recursive:true,force:true});}

export async function inspectSubjectReadiness(input: {
  repository: string;
  expectedSha: string;
  experimentPath: string;
  taskPath: string;
  provider?: string | null;
  dependenciesInstalled?: boolean;
  cwd?:string;
}): Promise<SubjectPreflight> {
  const {repository,expectedSha,experimentPath,taskPath,provider,dependenciesInstalled} = input;
  const trustedCwd=subjectPath(repository);const cwd=input.cwd??trustedCwd;
  const failures: string[] = [];
  const gitDirExists = existsSync(path.join(trustedCwd,'.git'));
  const gitMetadataIsolated=!existsSync(path.join(cwd,'.git'));
  const lockfilePath = path.join(cwd,'pnpm-lock.yaml');
  const lockfileExists = existsSync(lockfilePath);
  const nodeModulesExists = existsSync(path.join(cwd,'node_modules'));
  const experimentExists = existsSync(path.resolve(cwd,experimentPath));
  const taskExists = existsSync(taskPath);
  let headSha: string | null = null;

  if (gitDirExists) {
    const head = await runSubjectProcess('git',['rev-parse','HEAD'],trustedCwd,10_000).catch(() => null);
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

  if (!gitDirExists) failures.push('trusted git cache missing');
  if (!gitMetadataIsolated) failures.push('Pi workspace contains git metadata');
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
    lockfileExists,lockfileHash,nodeModulesExists,
    dependencyState: dependenciesInstalled === true ? 'installed' : dependenciesInstalled === false ? 'reused' : 'unknown',
    nodeVersion,pnpmVersion,experimentExists,taskExists,piBinary,piVersion,piAvailable,providerConfigured,gitMetadataIsolated,failures,
  };
}

export function getSubjectPath(repository:string){return subjectPath(repository);}
export function getRunSubjectPath(runId:string){return runSubjectPath(runId);}
