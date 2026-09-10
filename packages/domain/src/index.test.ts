import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeVerification, resolveExperimentAgent, resolveExperimentTools, validateExperimentDefinition, withElapsed, type RunState} from './index';

test('normalizes verifier commands', () => {
  assert.deepEqual(normalizeVerification({id:'x',taskFile:'task.md',verification:['pnpm test']}), [
    {id:'verify-1',command:'pnpm test',timeoutMs:1_800_000,required:true},
  ]);
});

test('validates and resolves experiment agent config', () => {
  const definition={id:'x',taskFile:'task.md',agent:{provider:'vercel-ai-gateway',model:'openai/gpt-oss-20b',thinking:'low',timeoutMs:900_000},tools:{allow:['read','edit','project_search'],extensions:['.wind-tunnel/tools.ts'],bootstrap:[{id:'context',entrypoint:'.wind-tunnel/context.ts'}]},verification:['pnpm test']};
  assert.deepEqual(validateExperimentDefinition(definition),[]);
  assert.deepEqual(resolveExperimentAgent(definition),{provider:'vercel-ai-gateway',model:'openai/gpt-oss-20b',thinking:'low',timeoutMs:900_000});
  assert.deepEqual(resolveExperimentTools(definition),{allow:definition.tools.allow,extensions:definition.tools.extensions,bootstrap:[{id:'context',entrypoint:'.wind-tunnel/context.ts',timeoutMs:3_000,maxOutputBytes:24_000,required:true}]});
});

test('rejects missing agent config', () => {
  const errors=validateExperimentDefinition({id:'x',taskFile:'task.md',verification:['pnpm test']});
  assert.ok(errors.includes('agent is required'));
});

test('rejects unsafe bootstrap entrypoints', () => {
  const definition={id:'x',taskFile:'task.md',agent:{provider:'p',model:'m',timeoutMs:30_000},tools:{bootstrap:[{entrypoint:'../context.ts'}]},verification:['pnpm test']};
  assert.ok(validateExperimentDefinition(definition).some(error=>error.includes('entrypoint')));
});

test('derives elapsed time', () => {
  const state: RunState = {
    runId:'00000000-0000-0000-0000-000000000000',status:'running',outcome:null,
    createdAt:'2026-01-01T00:00:00.000Z',startedAt:'2026-01-01T00:00:01.000Z',finishedAt:null,
    updatedAt:'2026-01-01T00:00:01.000Z',elapsedMs:0,error:null,errorCode:null,cancelRequestedAt:null,
    workerId:null,leaseUntil:null,attempts:1,
    spec:{runId:'00000000-0000-0000-0000-000000000000',subject:{repository:'fedorivanenko/nazare-hydrogen',githubSha:'a'.repeat(40)},experiment:{path:'.wind-tunnel/example/experiment.json'},agent:{provider:null,model:null,thinking:null,timeoutMs:0},tools:null,createdAt:'2026-01-01T00:00:00.000Z'},
  };
  assert.equal(withElapsed(state, Date.parse('2026-01-01T00:00:03.000Z')).elapsedMs, 2000);
});
