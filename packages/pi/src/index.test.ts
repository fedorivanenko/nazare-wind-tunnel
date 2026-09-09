import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runPi} from './index.js';

test('closes Pi stdin when prompt is passed as an argument', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wind-tunnel-pi-test-'));
  const executable = path.join(directory, 'pi-stdin-fixture.mjs');
  await writeFile(executable, `#!/usr/bin/env node
process.stdin.on('end', () => console.log(JSON.stringify({type:'session',id:'fixture'})));
process.stdin.resume();
`);
  await chmod(executable, 0o755);
  const previous = process.env.WIND_TUNNEL_PI_BIN;
  process.env.WIND_TUNNEL_PI_BIN = executable;
  try {
    const result = await runPi({cwd:directory,prompt:'fixture prompt',timeoutMs:10_000,startupTimeoutMs:5_000});
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"type":"session"/);
  } finally {
    if (previous === undefined) delete process.env.WIND_TUNNEL_PI_BIN;
    else process.env.WIND_TUNNEL_PI_BIN = previous;
    await rm(directory, {recursive:true,force:true});
  }
});
