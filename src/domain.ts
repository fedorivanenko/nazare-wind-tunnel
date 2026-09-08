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
