import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeVerification, resolveExperimentAgent, validateExperimentDefinition, withElapsed, type RunState} from './index';

test('normalizes verifier commands', () => {
  assert.deepEqual(normalizeVerification({id:'x',taskFile:'task.md',verification:['pnpm test']}), [
    {id:'verify-1',command:'pnpm test',timeoutMs:1_800_000,required:true},
  ]);
});

test('validates and resolves experiment agent config', () => {
  const definition={id:'x',taskFile:'task.md',agent:{provider:'vercel-ai-gateway',model:'openai/gpt-oss-20b',thinking:'low',timeoutMs:900_000},nazare:{capabilityId:'capability.x',requestedChange:'Change x'},verification:['pnpm test']};
  assert.deepEqual(validateExperimentDefinition(definition,'nazare'),[]);
  assert.deepEqual(resolveExperimentAgent(definition),{provider:'vercel-ai-gateway',model:'openai/gpt-oss-20b',thinking:'low',timeoutMs:900_000});
});

test('rejects missing agent config', () => {
  const errors=validateExperimentDefinition({id:'x',taskFile:'task.md',verification:['pnpm test']},'raw');
  assert.ok(errors.includes('agent is required'));
});

test('derives elapsed time', () => {
  const state: RunState = {
    runId:'00000000-0000-0000-0000-000000000000',status:'running',outcome:null,
    createdAt:'2026-01-01T00:00:00.000Z',startedAt:'2026-01-01T00:00:01.000Z',finishedAt:null,
    updatedAt:'2026-01-01T00:00:01.000Z',elapsedMs:0,error:null,errorCode:null,cancelRequestedAt:null,
    workerId:null,leaseUntil:null,attempts:1,
    spec:{runId:'00000000-0000-0000-0000-000000000000',subject:{repository:'fedorivanenko/nazare-hydrogen',githubSha:'a'.repeat(40)},experiment:{path:'.wind-tunnel/example/experiment.json'},arm:'nazare',agent:{provider:null,model:null,thinking:null,timeoutMs:0},createdAt:'2026-01-01T00:00:00.000Z'},
  };
  assert.equal(withElapsed(state, Date.parse('2026-01-01T00:00:03.000Z')).elapsedMs, 2000);
});
