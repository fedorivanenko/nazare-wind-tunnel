import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

const exec=promisify(execFile);

test('materializes git-free snapshot and captures candidate through temporary index',async()=>{
  const workspace=await mkdtemp(path.join(os.tmpdir(),'wind-tunnel-workspace-'));
  process.env.WIND_TUNNEL_WORKSPACE=workspace;
  const trusted=path.join(workspace,'repos','owner','repo');await mkdir(path.join(trusted,'node_modules'),{recursive:true});
  await exec('git',['init'],{cwd:trusted});
  await writeFile(path.join(trusted,'.gitignore'),'node_modules/\n');await writeFile(path.join(trusted,'kept.txt'),'before\n');await writeFile(path.join(trusted,'deleted.txt'),'remove\n');
  await exec('git',['add','.'],{cwd:trusted});await exec('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-m','baseline'],{cwd:trusted});
  const {stdout}=await exec('git',['rev-parse','HEAD'],{cwd:trusted});const sha=stdout.trim();
  const manager=await import('./index.js');const runId='00000000-0000-4000-8000-000000000001';
  try{
    const subject=await manager.materializeSubject('owner/repo',sha,runId);
    await assert.rejects(()=>readFile(path.join(subject.cwd,'.git')));
    await writeFile(path.join(subject.cwd,'kept.txt'),'after\n');await rm(path.join(subject.cwd,'deleted.txt'));await writeFile(path.join(subject.cwd,'added.txt'),'new\n');
    const captured=await manager.captureSubjectChanges('owner/repo',sha,runId);
    assert.match(captured.patch,/kept\.txt/);assert.match(captured.patch,/deleted\.txt/);assert.match(captured.patch,/added\.txt/);
    assert.deepEqual(captured.changedFiles.trim().split('\n'),['added.txt','deleted.txt','kept.txt']);
  }finally{await rm(workspace,{recursive:true,force:true});delete process.env.WIND_TUNNEL_WORKSPACE;}
});
