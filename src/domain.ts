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
  agent: {
    harness?: string;
    package?: string;
    provider?: string;
    model?: string;
    thinking?: string;
    timeoutMs?: number;
  };
  nazare: {capabilityId: string; requestedChange: string};
  verification: Array<string | Partial<VerificationSpec> & Pick<VerificationSpec, 'command'>>;
};

export type RunSpec = {
  runId: string;
  evaluator: {
    repository: string;
    githubSha: string;
    experimentDigest: string;
    taskDigest: string;
  };
  subject: {
    repository: string;
    githubSha: string;
  };
  experiment: {
    path: string;
    id: string;
  };
  task: {
    path: string;
  };
  arms: Arm[];
  agent: {
    harness: string;
    package: string | null;
    provider: string | null;
    model: string | null;
    thinking: string | null;
    timeoutMs: number;
  };
  verification: VerificationSpec[];
  controls: {
    subjectSource: 'identical';
    evaluator: 'immutable';
    task: 'identical';
    harness: 'identical';
    model: 'identical';
    provider: 'identical';
    independentVariable: 'contextCompiler';
  };
  createdAt: string;
};

export type ArmState = {
  arm: Arm;
  status: RunLifecycle;
  outcome: RunOutcome;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number;
  error: string | null;
  workspaceBaselineCommit: string | null;
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
  arms: Record<string, ArmState>;
};

export type RunEvent = {
  seq?: number;
  runId: string;
  type: string;
  at: string;
  arm?: Arm;
  data?: Record<string, unknown>;
};

export type ArtifactRecord = {
  runId: string;
  arm: Arm | null;
  type: string;
  key: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
};

export type VerificationResult = {
  id: string;
  command: string;
  required: boolean;
  status: 'passed' | 'failed';
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutArtifact: string | null;
  stderrArtifact: string | null;
};

export function normalizeVerification(definition: ExperimentDefinition): VerificationSpec[] {
  return definition.verification.map((item, index) => {
    if (typeof item === 'string') {
      return {id: `verify-${index + 1}`, command: item, timeoutMs: 30 * 60 * 1000, required: true};
    }
    return {
      id: item.id ?? `verify-${index + 1}`,
      command: item.command,
      timeoutMs: item.timeoutMs ?? 30 * 60 * 1000,
      required: item.required ?? true,
    };
  });
}

export function elapsedMs(startedAt: string | null, finishedAt: string | null, now = Date.now()) {
  if (!startedAt) return 0;
  return Math.max(0, Date.parse(finishedAt ?? new Date(now).toISOString()) - Date.parse(startedAt));
}

export function withElapsed(state: RunState): RunState {
  const arms = Object.fromEntries(Object.entries(state.arms).map(([name, arm]) => [name, {
    ...arm,
    elapsedMs: elapsedMs(arm.startedAt, arm.finishedAt),
  }]));
  return {...state, elapsedMs: elapsedMs(state.startedAt ?? state.createdAt, state.finishedAt), arms};
}
