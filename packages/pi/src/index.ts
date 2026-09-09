import {spawn} from 'node:child_process';

export type PiRunOptions = {
  cwd: string;
  prompt: string;
  provider?: string;
  model?: string;
  thinking?: string;
  timeoutMs: number;
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void | Promise<void>;
  onStderrLine?: (line: string) => void | Promise<void>;
};

export type PiTimeoutReason = 'startup' | 'idle' | 'overall' | null;

export type PiSemanticEvent = {
  type: string;
  data?: Record<string, unknown>;
};

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromContent).join('');
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.delta === 'string') return item.delta;
  if (item.content != null) return textFromContent(item.content);
  return '';
}

export function normalizePiJsonLine(line: string): PiSemanticEvent[] {
  let event: Record<string, any>;
  try {
    event = JSON.parse(line) as Record<string, any>;
  } catch {
    return [{type:'agent.output.unparsed',data:{text:line.slice(0,8_000)}}];
  }

  const type = String(event.type ?? '');
  if (type === 'session') return [{type:'agent.session',data:{sessionId:event.id,version:event.version,cwd:event.cwd}}];
  if (type === 'agent_start') return [{type:'agent.lifecycle',data:{state:'started'}}];
  if (type === 'agent_end') return [{type:'agent.lifecycle',data:{state:'ended',willRetry:event.willRetry}}];
  if (type === 'agent_settled') return [{type:'agent.lifecycle',data:{state:'settled'}}];
  if (type === 'turn_start') return [{type:'agent.turn.started'}];
  if (type === 'turn_end') return [{type:'agent.turn.completed',data:{toolResults:Array.isArray(event.toolResults)?event.toolResults.length:0,usage:event.message?.usage}}];

  if (type === 'message_start') {
    const message = event.message ?? {};
    return [{type:'agent.message.started',data:{role:message.role ?? 'assistant',provider:message.provider,model:message.model,text:textFromContent(message.content)}}];
  }

  if (type === 'message_end') {
    const message = event.message ?? {};
    return [{type:'agent.message.completed',data:{role:message.role ?? 'assistant',text:textFromContent(message.content),usage:message.usage,stopReason:message.stopReason,responseId:message.responseId}}];
  }

  if (type === 'message_update') {
    const update = event.assistantMessageEvent ?? event.delta ?? {};
    const updateType = String(update.type ?? '');
    if (updateType === 'thinking_start') return [{type:'agent.thinking.started',data:{contentIndex:update.contentIndex}}];
    if (updateType === 'thinking_delta') return [{type:'agent.thinking.delta',data:{text:String(update.delta ?? ''),contentIndex:update.contentIndex}}];
    if (updateType === 'thinking_end') return [{type:'agent.thinking.completed',data:{text:String(update.content ?? ''),contentIndex:update.contentIndex}}];
    if (updateType === 'text_start') return [{type:'agent.message.text.started',data:{contentIndex:update.contentIndex}}];
    if (updateType === 'text_delta') return [{type:'agent.message.delta',data:{role:'assistant',text:String(update.delta ?? ''),contentIndex:update.contentIndex}}];
    if (updateType === 'text_end') return [{type:'agent.message.text.completed',data:{text:String(update.content ?? ''),contentIndex:update.contentIndex}}];
    return [{type:'agent.message.update',data:{updateType,usage:event.usage}}];
  }

  if (type === 'tool_execution_start' || type === 'tool_call_start' || type === 'tool_call' || type === 'tool_use') {
    return [{type:'agent.tool.started',data:{name:event.toolName ?? event.tool_name ?? event.name ?? event.tool?.name ?? 'tool',args:event.args ?? event.arguments ?? event.input ?? event.tool?.input}}];
  }
  if (type === 'tool_execution_update') {
    return [{type:'agent.tool.update',data:{name:event.toolName ?? event.tool_name ?? event.name ?? 'tool',text:textFromContent(event.output ?? event.result ?? event.content)}}];
  }
  if (type === 'tool_execution_end' || type === 'tool_call_end' || type === 'tool_result') {
    return [{type:'agent.tool.completed',data:{name:event.toolName ?? event.tool_name ?? event.name ?? event.tool?.name ?? 'tool',result:textFromContent(event.result ?? event.output ?? event.content),error:event.error}}];
  }

  return [{type:'agent.pi',data:{piType:type || 'unknown'}}];
}

export async function runPi(options: PiRunOptions) {
  const args = ['--mode','json','-p','--no-session','--no-approve'];
  if (options.provider) args.push('--provider', options.provider);
  if (options.model) args.push('--model', options.model);
  if (options.thinking) args.push('--thinking', options.thinking);
  args.push('--', options.prompt);

  const piBin = process.env.WIND_TUNNEL_PI_BIN ?? 'pi';
  const started = Date.now();
  return await new Promise<{exitCode:number|null; stdout:string; stderr:string; durationMs:number; timedOut:boolean; timeoutReason:PiTimeoutReason; aborted:boolean; firstOutputMs:number|null; lastActivityAt:string|null}>((resolve, reject) => {
    const child = spawn(piBin, args, {cwd: options.cwd, env: {...process.env, PI_SKIP_VERSION_CHECK:'1', PI_TELEMETRY:'0'}});
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let timedOut = false;
    let timeoutReason: PiTimeoutReason = null;
    let aborted = false;
    let settled = false;
    let firstOutputMs: number | null = null;
    let lastActivityAt: string | null = null;
    let idleTimer: NodeJS.Timeout | null = null;

    const terminate = (reason: 'startup' | 'idle' | 'overall' | 'abort') => {
      if (settled) return;
      if (reason === 'abort') aborted = true;
      else {
        timedOut = true;
        timeoutReason = reason;
      }
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 2_000).unref();
    };

    const resetIdleTimer = () => {
      if (!options.idleTimeoutMs || options.idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => terminate('idle'), options.idleTimeoutMs);
      idleTimer.unref();
    };

    const noteActivity = () => {
      if (firstOutputMs == null) firstOutputMs = Date.now() - started;
      lastActivityAt = new Date().toISOString();
      resetIdleTimer();
    };

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

    child.stdout?.on('data', chunk => {
      noteActivity();
      const text = chunk.toString();
      stdout = (stdout + text).slice(-20_000_000);
      emitLines('stdout', text);
    });
    child.stderr?.on('data', chunk => {
      noteActivity();
      const text = chunk.toString();
      stderr = (stderr + text).slice(-20_000_000);
      emitLines('stderr', text);
    });
    child.on('error', reject);

    const onAbort = () => terminate('abort');
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, {once:true});

    const overallTimer = setTimeout(() => terminate('overall'), options.timeoutMs);
    const startupTimer = options.startupTimeoutMs && options.startupTimeoutMs > 0
      ? setTimeout(() => { if (firstOutputMs == null) terminate('startup'); }, options.startupTimeoutMs)
      : null;
    overallTimer.unref();
    startupTimer?.unref();

    child.on('close', exitCode => {
      settled = true;
      clearTimeout(overallTimer);
      if (startupTimer) clearTimeout(startupTimer);
      if (idleTimer) clearTimeout(idleTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (stdoutBuffer && options.onStdoutLine) Promise.resolve(options.onStdoutLine(stdoutBuffer)).catch(() => {});
      if (stderrBuffer && options.onStderrLine) Promise.resolve(options.onStderrLine(stderrBuffer)).catch(() => {});
      resolve({exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut, timeoutReason, aborted, firstOutputMs, lastActivityAt});
    });
  });
}
