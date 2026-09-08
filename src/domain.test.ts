import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVerification, type RunSpec} from './domain';

test('normalizes string and object verification entries', () => {
  const checks = normalizeVerification({
    id: 'x',
    taskFile: 'task.md',
    agent: {},
    nazare: {capabilityId: 'capability.x', requestedChange: 'change'},
    verification: [
      'npm test',
      {id: 'build', command: 'npm run build', required: false, timeoutMs: 1234},
    ],
  });
  assert.deepEqual(checks[0], {id: 'verify-1', command: 'npm test', timeoutMs: 1_800_000, required: true});
  assert.deepEqual(checks[1], {id: 'build', command: 'npm run build', timeoutMs: 1234, required: false});
});

test('RunSpec freezes evaluator and subject independently', () => {
  const spec: RunSpec = {
    runId: '00000000-0000-0000-0000-000000000000',
    evaluator: {
      repository: 'fedorivanenko/nazare-wind-tunnel',
      githubSha: 'a'.repeat(40),
      experimentDigest: 'e'.repeat(64),
      taskDigest: 't'.repeat(64),
    },
    subject: {
      repository: 'fedorivanenko/nazare-hydrogen',
      githubSha: 'b'.repeat(40),
    },
    experiment: {path: 'experiments/x.json', id: 'x'},
    task: {path: 'experiments/task.md'},
    arms: ['raw', 'nazare'],
    agent: {harness: 'pi', package: null, provider: null, model: null, thinking: null, timeoutMs: 1},
    verification: [],
    controls: {
      subjectSource: 'identical',
      evaluator: 'immutable',
      task: 'identical',
      harness: 'identical',
      model: 'identical',
      provider: 'identical',
      independentVariable: 'contextCompiler',
    },
    createdAt: new Date(0).toISOString(),
  };
  assert.notEqual(spec.evaluator.githubSha, spec.subject.githubSha);
  assert.equal(spec.controls.evaluator, 'immutable');
  assert.equal(spec.controls.independentVariable, 'contextCompiler');
});
