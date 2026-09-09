export type Arm = 'raw' | 'nazare';
export type RunLifecycle = 'queued' | 'preparing' | 'running' | 'verifying' | 'completed' | 'failed' | 'cancelled';
export type RunOutcome = 'pass' | 'fail' | 'inconclusive' | null;

export type VerificationSpec = {
  id: string;
  command: string;
  timeoutMs: number;
  required: boolean;
};

export type ExperimentDefinition = {
  id: string;
  taskFile: string;
  agent?: {
    provider?: string;
    model?: string;
    thinking?: string;
    timeoutMs?: number;
  };
  nazare?: {capabilityId: string; requestedChange: string};
  verification: Array<string | (Partial<VerificationSpec> & Pick<VerificationSpec, 'command'>)>;
};

export type RunSpec = {
  runId: string;
  subject: {repository: string; githubSha: string};
  experiment: {path: string};
  arm: Arm;
  agent: {
    provider: string | null;
    model: string | null;
    thinking: string | null;
    timeoutMs: number;
  };
  createdAt: string;
};

export type RunState = {
  runId: string;
  status: RunLifecycle;
  outcome: RunOutcome;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  elapsedMs: number;
  error: string | null;
  workerId: string | null;
  leaseUntil: string | null;
  attempts: number;
  spec: RunSpec;
};

export type RunEvent = {
  seq?: number;
  runId: string;
  type: string;
  at: string;
  data?: Record<string, unknown>;
};

export type ArtifactRecord = {
  runId: string;
  type: string;
  key: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
};

export function normalizeVerification(definition: ExperimentDefinition): VerificationSpec[] {
  return definition.verification.map((item, index) => {
    if (typeof item === 'string') return {id: `verify-${index + 1}`, command: item, timeoutMs: 30 * 60 * 1000, required: true};
    return {
      id: item.id ?? `verify-${index + 1}`,
      command: item.command,
      timeoutMs: item.timeoutMs ?? 30 * 60 * 1000,
      required: item.required ?? true,
    };
  });
}

export function withElapsed(state: RunState, now = Date.now()): RunState {
  if (!state.startedAt) return {...state, elapsedMs: 0};
  return {
    ...state,
    elapsedMs: Math.max(0, Date.parse(state.finishedAt ?? new Date(now).toISOString()) - Date.parse(state.startedAt)),
  };
}

export const TERMINAL_STATES: RunLifecycle[] = ['completed', 'failed', 'cancelled'];
