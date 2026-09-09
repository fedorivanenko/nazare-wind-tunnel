import {spawn} from 'node:child_process';

export type PiRunOptions = {
  cwd: string;
  prompt: string;
  provider?: string;
  model?: string;
  thinking?: string;
  timeoutMs: number;
};

export async function runPi(options: PiRunOptions) {
  const args = ['--mode','json','-p','--no-session','--no-approve'];
  if (options.provider) args.push('--provider', options.provider);
  if (options.model) args.push('--model', options.model);
  if (options.thinking) args.push('--thinking', options.thinking);
  args.push('--', options.prompt);

  const started = Date.now();
  return await new Promise<{exitCode:number|null; stdout:string; stderr:string; durationMs:number; timedOut:boolean}>((resolve, reject) => {
    const child = spawn('pi', args, {cwd: options.cwd, env: {...process.env, PI_SKIP_VERSION_CHECK:'1', PI_TELEMETRY:'0'}});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-20_000_000); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-20_000_000); });
    child.on('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs);
    child.on('close', exitCode => {
      clearTimeout(timer);
      resolve({exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut});
    });
  });
}
