# Nazare Wind Tunnel

Independent evaluation infrastructure for Nazare experiments.

The system under test lives in `fedorivanenko/nazare-hydrogen`. Wind Tunnel owns the experiment definitions, task corpus, verifier configuration, run lifecycle, artifacts, and evaluation policy.

## Trust boundary

Every run freezes two independent commits:

- `subjectSha` — the exact `nazare-hydrogen` commit being tested.
- `evaluatorSha` — the exact `nazare-wind-tunnel` commit defining the benchmark and judge.

The candidate may change the subject, but it cannot change the evaluator, benchmark corpus, verifier, scoring policy, or acceptance logic.

## Runtime

```text
ChatGPT / CLI / dashboard
          |
          v
Railway control + OAuth
  freeze evaluatorSha + subjectSha
          |
          v
Postgres durable queue/state
          |
          v
Railway worker
  checkout subjectSha
  npm ci
  raw + nazare worktrees
  same Pi/model/task/verifier
          |
          v
Railway S3 bucket
  patches, transcripts, compiled context,
  changed files, verifier output, metrics
```

The experimental independent variable is only the context compiler:

- `raw` — Pi works on the subject repository normally.
- `nazare` — the same Pi/model gets the same repository and task plus `.nazare/task.json` compiled by Nazare.

## Services

Public control service start command:

```sh
npx tsx src/oauth-gateway.ts
```

Private worker start command:

```sh
npx tsx src/worker.ts
```

Both services should deploy the same `nazare-wind-tunnel` commit.

## Required environment

Control:

- `DATABASE_URL`
- `WIND_TUNNEL_TOKEN`
- `WIND_TUNNEL_S3_BUCKET`
- `WIND_TUNNEL_S3_REGION`
- `WIND_TUNNEL_S3_ENDPOINT`
- `WIND_TUNNEL_S3_ACCESS_KEY`
- `WIND_TUNNEL_S3_SECRET_KEY`
- `WIND_TUNNEL_SUBJECT_REPO=fedorivanenko/nazare-hydrogen`
- `WIND_TUNNEL_SUBJECT_REF=main`
- `RAILPACK_DEPLOY_APT_PACKAGES=postgresql-client git`

Worker:

- same Postgres/S3 variables
- `AI_GATEWAY_API_KEY`
- `RAILPACK_DEPLOY_APT_PACKAGES=postgresql-client git`

The public control service keeps the existing `/workspace` volume only for OAuth state. Run state lives in Postgres, artifacts live in S3, and subject workspaces are disposable.

## MCP surface

- `workspace_status`
- `list_experiments`
- `get_experiment`
- `start_experiment`
- `get_run_status`
- `get_run`
- `get_run_artifacts`
- `list_runs`

`start_experiment` accepts an optional exact `subjectSha`; otherwise it resolves the configured subject branch and freezes its current GitHub SHA before queueing the run.
