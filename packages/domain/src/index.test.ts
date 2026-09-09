import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeVerification, withElapsed, type RunState} from './index';

test('normalizes verifier commands', () => {
  assert.deepEqual(normalizeVerification({id:'x',taskFile:'task.md',verification:['pnpm test']}), [
    {id:'verify-1',command:'pnpm test',timeoutMs:1_800_000,required:true},
  ]);
});

test('derives elapsed time', () => {
  const state: RunState = {
    runId:'00000000-0000-0000-0000-000000000000',status:'running',outcome:null,
    createdAt:'2026-01-01T00:00:00.000Z',startedAt:'2026-01-01T00:00:01.000Z',finishedAt:null,
    updatedAt:'2026-01-01T00:00:01.000Z',elapsedMs:0,error:null,errorCode:null,cancelRequestedAt:null,
    workerId:null,leaseUntil:null,attempts:1,
    spec:{runId:'00000000-0000-0000-0000-000000000000',subject:{repository:'fedorivanenko/nazare-hydrogen',githubSha:'a'.repeat(40)},experiment:{path:'.wind-tunnel/example/experiment.json'},arm:'nazare',agent:{provider:null,model:null,thinking:null,timeoutMs:1000},createdAt:'2026-01-01T00:00:00.000Z'},
  };
  assert.equal(withElapsed(state, Date.parse('2026-01-01T00:00:03.000Z')).elapsedMs, 2000);
});
