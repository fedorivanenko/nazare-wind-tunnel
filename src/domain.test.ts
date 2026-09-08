import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultEnvironments, normalizeVerification, type RunSpec} from './domain';

test('normalizes string and object verification entries', () => {
  const checks = normalizeVerification({
    id: 'x',
    taskFile: 'task.md',
    agent: {},
    environments: {raw: {compiler: 'none', version: '1'}},
    verification: [
      'npm test',
      {id: 'build', command: 'npm run build', required: false, timeoutMs: 1234},
    ],
  });
  assert.deepEqual(checks[0], {id: 'verify-1', command: 'npm test', timeoutMs: 1_800_000, required: true});
  assert.deepEqual(checks[1], {id: 'build', command: 'npm run build', timeoutMs: 1234, required: false});
});

test('legacy raw/nazare definitions normalize into environment versions', () => {
  const environments = defaultEnvironments({
    id: 'x',
    taskFile: 'task.md',
    agent: {},
    nazare: {capabilityId: 'capability.x', requestedChange: 'change'},
    verification: [],
  });
  assert.deepEqual(environments.raw, {compiler: 'none', version: '1'});
  assert.equal(environments.nazare.compiler, 'nazare');
  assert.equal(environments.nazare.config?.capabilityId, 'capability.x');
});

test('RunSpec freezes evaluator, subject, worker image and environment independently', () => {
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
    arms: ['raw', 'nazare-projection-v1'],
    environments: {
      raw: {compiler: 'none', version: '1'},
      'nazare-projection-v1': {compiler: 'nazare', version: 'registry-projection-v1'},
    },
    agent: {harness: 'pi', package: null, provider: null, model: null, thinking: null, timeoutMs: 1},
    verification: [],
    execution: {workerImageDigest: 'sha256:worker'},
    controls: {
      subjectSource: 'identical',
      evaluator: 'immutable',
      task: 'identical',
      harness: 'identical',
      model: 'identical',
      provider: 'identical',
      workerImage: 'identical',
      independentVariable: 'environmentCompiler',
    },
    createdAt: new Date(0).toISOString(),
  };
  assert.notEqual(spec.evaluator.githubSha, spec.subject.githubSha);
  assert.equal(spec.controls.evaluator, 'immutable');
  assert.equal(spec.controls.workerImage, 'identical');
  assert.equal(spec.controls.independentVariable, 'environmentCompiler');
  assert.equal(spec.environments['nazare-projection-v1'].version, 'registry-projection-v1');
});
