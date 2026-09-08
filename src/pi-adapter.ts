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
    const detached = process.platform !== 'win32';
    const child = spawn('npx', args, {
      cwd: options.cwd,
      detached,
      env: {
        ...process.env,
        PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? '1',
        PI_TELEMETRY: process.env.PI_TELEMETRY ?? '0',
        AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_API_KEY ?? '',
      },
    });
    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let settled = false;
    let agentError: string | null = null;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const terminateGracefully = () => {
      terminate('SIGTERM');
      forceKillTimer = setTimeout(() => terminate('SIGKILL'), 5_000);
      forceKillTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminateGracefully();
    }, options.timeoutMs);

    child.stdout?.on('data', chunk => {
      stdout = appendBounded(stdout, chunk);
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as {type?: string; message?: {stopReason?: string; errorMessage?: string}};
          if (event.type === 'message_end' && event.message?.stopReason === 'error') {
            agentError = event.message.errorMessage ?? 'Pi model request failed';
          }
          if (event.type === 'agent_settled' && !settled) {
            settled = true;
            clearTimeout(timer);
            terminateGracefully();
          }
        } catch {}
      }
    });
    child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk); });
    child.on('error', reject);

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        command: `npx ${args.slice(0, -1).join(' ')} <prompt>`,
        exitCode: agentError ? 1 : settled ? 0 : exitCode,
        signal,
        stdout,
        stderr: agentError ? `${stderr}\n${agentError}`.trim() : stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}
