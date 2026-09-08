export type Arm = string;
export type RunLifecycle = 'queued' | 'preparing' | 'running' | 'verifying' | 'completed' | 'failed' | 'cancelled';
export type RunOutcome = 'pass' | 'fail' | 'inconclusive' | null;
export type FailureKind =
  | 'worker_environment'
  | 'source_checkout'
  | 'dependency_install'
  | 'environment_compile'
  | 'agent_harness'
  | 'model_provider'
  | 'verification_infrastructure'
  | 'unknown';

export type EnvironmentSpec = {
  compiler: 'none' | 'nazare' | string;
  version: string;
  config?: Record<string, unknown>;
};

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
  environments?: Record<string, EnvironmentSpec>;
  nazare?: {capabilityId: string; requestedChange: string};
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
  environments: Record<string, EnvironmentSpec>;
  agent: {
    harness: string;
    package: string | null;
    provider: string | null;
    model: string | null;
    thinking: string | null;
    timeoutMs: number;
  };
  verification: VerificationSpec[];
  execution: {
    workerImageDigest: string;
  };
  controls: {
    subjectSource: 'identical';
    evaluator: 'immutable';
    task: 'identical';
    harness: 'identical';
    model: 'identical';
    provider: 'identical';
    workerImage: 'identical';
    independentVariable: 'environmentCompiler';
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
  failureKind: FailureKind | null;
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
  failureKind: FailureKind | null;
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

export function defaultEnvironments(definition: ExperimentDefinition): Record<string, EnvironmentSpec> {
  if (definition.environments && Object.keys(definition.environments).length) return definition.environments;
  return {
    raw: {compiler: 'none', version: '1'},
    nazare: {
      compiler: 'nazare',
      version: 'registry-projection-v1',
      config: definition.nazare ? {...definition.nazare} : {},
    },
  };
}

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

export function deriveRunLifecycle(state: Pick<RunState, 'arms'>): RunLifecycle {
  const arms = Object.values(state.arms);
  const allTerminal = arms.length > 0 && arms.every(arm => ['completed', 'failed', 'cancelled'].includes(arm.status));
  if (allTerminal) {
    if (arms.some(arm => arm.status === 'failed')) return 'failed';
    if (arms.some(arm => arm.status === 'cancelled')) return 'cancelled';
    return 'completed';
  }
  if (arms.some(arm => arm.status === 'verifying')) return 'verifying';
  if (arms.some(arm => arm.status === 'running')) return 'running';
  return 'preparing';
}

export function deriveRunOutcome(state: Pick<RunState, 'arms'>): RunOutcome {
  const arms = Object.values(state.arms);
  if (!arms.length || !arms.every(arm => arm.status === 'completed')) return null;
  if (arms.some(arm => arm.outcome === 'fail')) return 'fail';
  if (arms.some(arm => arm.outcome === 'inconclusive')) return 'inconclusive';
  return 'pass';
}

export function elapsedMs(startedAt: string | null, finishedAt: string | null, now = Date.now()) {
  if (!startedAt) return 0;
  return Math.max(0, Date.parse(finishedAt ?? new Date(now).toISOString()) - Date.parse(startedAt));
}

export function withElapsed(state: RunState): RunState {
  const arms = Object.fromEntries(Object.entries(state.arms).map(([name, arm]) => [name, {
    ...arm,
    failureKind: arm.failureKind ?? null,
    elapsedMs: elapsedMs(arm.startedAt, arm.finishedAt),
  }]));
  return {
    ...state,
    failureKind: state.failureKind ?? null,
    elapsedMs: elapsedMs(state.startedAt ?? state.createdAt, state.finishedAt),
    arms,
  };
}
