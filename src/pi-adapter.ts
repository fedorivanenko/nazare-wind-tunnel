import {spawn} from 'node:child_process';

export type PiRunOptions = {
  cwd: string;
  prompt: string;
  provider?: string;
  model?: string;
  thinking?: string;
  timeoutMs: number;
};

export type PiRunResult = {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

const MAX_OUTPUT_BYTES = 20_000_000;
const PI_PACKAGE = process.env.WIND_TUNNEL_PI_PACKAGE ?? '@earendil-works/pi-coding-agent@0.85.1';

function appendBounded(current: string, chunk: Buffer | string) {
  if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current;
  const next = current + chunk.toString();
  return Buffer.byteLength(next) > MAX_OUTPUT_BYTES ? next.slice(0, MAX_OUTPUT_BYTES) : next;
}

export async function runPi(options: PiRunOptions): Promise<PiRunResult> {
  const args = [
    '--yes',
    PI_PACKAGE,
    '--mode',
    'json',
    '-p',
    '--no-session',
    '--no-approve',
  ];
  if (options.provider) args.push('--provider', options.provider);
  if (options.model) args.push('--model', options.model);
  if (options.thinking) args.push('--thinking', options.thinking);
  args.push('--', options.prompt);

  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn('npx', args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? '1',
        PI_TELEMETRY: process.env.PI_TELEMETRY ?? '0',
      },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk); });
    child.on('error', reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs);

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command: `npx ${args.slice(0, -1).join(' ')} <prompt>`,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}
