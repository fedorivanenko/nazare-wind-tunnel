import {spawn} from 'node:child_process';

export type PiRunOptions = {
  cwd: string;
  prompt: string;
  provider?: string;
  model?: string;
  thinking?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void | Promise<void>;
  onStderrLine?: (line: string) => void | Promise<void>;
};

export async function runPi(options: PiRunOptions) {
  const args = ['--mode','json','-p','--no-session','--no-approve'];
  if (options.provider) args.push('--provider', options.provider);
  if (options.model) args.push('--model', options.model);
  if (options.thinking) args.push('--thinking', options.thinking);
  args.push('--', options.prompt);

  const piBin = process.env.WIND_TUNNEL_PI_BIN ?? 'pi';
  const started = Date.now();
  return await new Promise<{exitCode:number|null; stdout:string; stderr:string; durationMs:number; timedOut:boolean; aborted:boolean}>((resolve, reject) => {
    const child = spawn(piBin, args, {cwd: options.cwd, env: {...process.env, PI_SKIP_VERSION_CHECK:'1', PI_TELEMETRY:'0'}});
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const emitLines = (kind: 'stdout' | 'stderr', chunk: string) => {
      if (kind === 'stdout') stdoutBuffer += chunk;
      else stderrBuffer += chunk;
      let buffer = kind === 'stdout' ? stdoutBuffer : stderrBuffer;
      const callback = kind === 'stdout' ? options.onStdoutLine : options.onStderrLine;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0,index);
        buffer = buffer.slice(index + 1);
        if (line && callback) Promise.resolve(callback(line)).catch(() => {});
      }
      if (kind === 'stdout') stdoutBuffer = buffer;
      else stderrBuffer = buffer;
    };

    const terminate = (reason: 'timeout' | 'abort') => {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      else aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 2_000).unref();
    };

    child.stdout?.on('data', chunk => {
      const text = chunk.toString();
      stdout = (stdout + text).slice(-20_000_000);
      emitLines('stdout', text);
    });
    child.stderr?.on('data', chunk => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-20_000_000);
      emitLines('stderr', text);
    });
    child.on('error', reject);

    const onAbort = () => terminate('abort');
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, {once:true});

    const timer = setTimeout(() => terminate('timeout'), options.timeoutMs);
    child.on('close', exitCode => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (stdoutBuffer && options.onStdoutLine) Promise.resolve(options.onStdoutLine(stdoutBuffer)).catch(() => {});
      if (stderrBuffer && options.onStderrLine) Promise.resolve(options.onStderrLine(stderrBuffer)).catch(() => {});
      resolve({exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut, aborted});
    });
  });
}
