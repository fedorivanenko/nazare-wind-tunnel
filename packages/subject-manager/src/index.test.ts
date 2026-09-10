import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runSubjectProcess} from './index';

test('subject processes receive input but not worker secrets',async()=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'wind-tunnel-subject-process-'));
  process.env.WIND_TUNNEL_TOKEN='must-not-leak';
  try{
    const script="let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.stringify({input:s,secret:process.env.WIND_TUNNEL_TOKEN??null})))";
    const result=await runSubjectProcess(process.execPath,['-e',script],cwd,5_000,undefined,{input:'fixture'});
    assert.equal(result.exitCode,0);
    assert.deepEqual(JSON.parse(result.stdout),{input:'fixture',secret:null});
  }finally{delete process.env.WIND_TUNNEL_TOKEN;await rm(cwd,{recursive:true,force:true});}
});
