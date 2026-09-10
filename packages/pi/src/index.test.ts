import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPiExtensions, piRuntimeEnv, runPi} from './index.js';

test('Pi environment includes selected provider key but excludes worker secrets',()=>{
  process.env.AI_GATEWAY_API_KEY='provider-key';process.env.DATABASE_URL='database-secret';process.env.WIND_TUNNEL_TOKEN='control-secret';
  try{const env=piRuntimeEnv('vercel-ai-gateway');assert.equal(env.AI_GATEWAY_API_KEY,'provider-key');assert.equal(env.DATABASE_URL,undefined);assert.equal(env.WIND_TUNNEL_TOKEN,undefined);}
  finally{delete process.env.AI_GATEWAY_API_KEY;delete process.env.DATABASE_URL;delete process.env.WIND_TUNNEL_TOKEN;}
});

test('inspects registered custom tool schemas', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'wind-tunnel-extension-test-'));
  const extension=path.join(directory,'tools.mjs');
  await writeFile(extension,`export default pi => pi.registerTool({name:'project_search',label:'Project Search',description:'Search project',promptSnippet:'Search first',parameters:{type:'object',properties:{query:{type:'string'}}}});`);
  try{
    assert.deepEqual(await inspectPiExtensions([{path:'.wind-tunnel/tools.mjs',absolutePath:extension,sha256:'fixture'}]),[{name:'project_search',label:'Project Search',description:'Search project',promptSnippet:'Search first',parameters:{type:'object',properties:{query:{type:'string'}}},extension:'.wind-tunnel/tools.mjs'}]);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('closes Pi stdin when prompt is passed as an argument', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wind-tunnel-pi-test-'));
  const executable = path.join(directory, 'pi-stdin-fixture.mjs');
  await writeFile(executable, `#!/usr/bin/env node
process.stdin.on('end', () => console.log(JSON.stringify({type:'session',id:'fixture',argv:process.argv.slice(2)})));
process.stdin.resume();
`);
  await chmod(executable, 0o755);
  const previous = process.env.WIND_TUNNEL_PI_BIN;
  process.env.WIND_TUNNEL_PI_BIN = executable;
  try {
    const extension = path.join(directory, 'tools.ts');
    await writeFile(extension, 'export default function () {}');
    const result = await runPi({cwd:directory,prompt:'fixture prompt',tools:['read','custom_tool'],extensions:[extension],timeoutMs:10_000,startupTimeoutMs:5_000});
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"type":"session"/);
    const argv = JSON.parse(result.stdout.trim()).argv as string[];
    assert.ok(argv.includes('--no-extensions'));
    assert.deepEqual(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2), ['--tools','read,custom_tool']);
    assert.deepEqual(argv.slice(argv.indexOf('--extension'), argv.indexOf('--extension') + 2), ['--extension',extension]);
  } finally {
    if (previous === undefined) delete process.env.WIND_TUNNEL_PI_BIN;
    else process.env.WIND_TUNNEL_PI_BIN = previous;
    await rm(directory, {recursive:true,force:true});
  }
});
