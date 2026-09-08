# Nazare Wind Tunnel

Independent evaluation infrastructure for Nazare environment-compiler experiments.

The system under test lives in `fedorivanenko/nazare-hydrogen`. Wind Tunnel owns the experiment definitions, task corpus, verifier configuration, run lifecycle, artifacts, execution provenance, and evaluation policy.

## Trust boundary

Every run freezes independent immutable inputs:

- `subjectSha` — the exact `nazare-hydrogen` commit being tested.
- `evaluatorSha` — the exact `nazare-wind-tunnel` commit defining the benchmark and judge.
- `workerImageDigest` — the exact execution environment expected by the worker.
- environment definitions — the named compiler/version/config used by each arm.
- model, harness, task digest, verifier configuration, and experiment digest.

The candidate may change only its disposable subject workspace. It cannot change the evaluator, benchmark corpus, verifier, scoring policy, or acceptance logic.

The experimental independent variable is `environmentCompiler`.

## Architecture

```text
ChatGPT / CLI / dashboard
          |
          v
control / MCP
  freeze evaluatorSha + subjectSha
  + workerImageDigest + environments
          |
          v
Postgres durable queue/state
          |
          v
worker (same Docker image locally/Railway)
  startup preflight
  checkout exact subjectSha
          |
     +----+-------------------+
     |                        |
     v                        v
raw workspace         nazare-projection-v1 workspace
npm ci                npm ci
compiler:none         compiler:nazare
     |                        |
     +--------- same Pi/model/task --------+
                              |
                              v
                       same independent verifier
                              |
                              v
                         S3 artifacts
```

`raw` is not a special execution path. It is an environment definition with `compiler: "none"`. Nazare variants are named/versioned environment definitions such as `nazare-projection-v1`. More variants can be added without changing the worker orchestration.

Each arm has an independent mutable worktree and independent dependency install. A shared package-manager cache is acceptable, but mutable `node_modules` is not shared between arms.

## Local parity

The same controller/worker code and worker Dockerfile are used locally and on Railway.

Start the local stack:

```sh
VERCEL_AI_GATEWAY_API_KEY=... docker compose up --build
```

This starts:

- control on `http://localhost:3001`
- worker
- Postgres on local port `54329`
- MinIO S3-compatible storage on `9000` with console on `9001`

Local MCP token: `local-wind-tunnel-token`.

The worker refuses to start if required runtime tools are missing. Preflight checks `git`, `node`, `npm`, `npx`, `psql`, Postgres configuration, and artifact-store configuration before the worker can claim a run.

## Railway

Build and deploy `Dockerfile.worker` for the private worker and `Dockerfile.control` for control/OAuth. Railway should run the exact image digest tested locally and provide that digest to both services as `WIND_TUNNEL_WORKER_IMAGE_DIGEST`.

Do not install subject runtime dependencies through Railway-specific shell setup. Node/npm/git/psql are declared by the worker image; subject dependencies are installed inside each disposable arm workspace with `npm ci`.

## Required environment

Shared control/worker configuration:

- `DATABASE_URL`
- `WIND_TUNNEL_S3_BUCKET`
- `WIND_TUNNEL_S3_REGION`
- `WIND_TUNNEL_S3_ENDPOINT`
- `WIND_TUNNEL_S3_ACCESS_KEY`
- `WIND_TUNNEL_S3_SECRET_KEY`
- `WIND_TUNNEL_WORKER_IMAGE_DIGEST`
- `WIND_TUNNEL_SUBJECT_REPO=fedorivanenko/nazare-hydrogen`
- `WIND_TUNNEL_SUBJECT_REF=main`

Control additionally needs:

- `WIND_TUNNEL_TOKEN`

Worker additionally needs the model-provider credentials used by the experiment, currently the Vercel AI Gateway credential.

For local MinIO only, set `WIND_TUNNEL_S3_FORCE_PATH_STYLE=1`.

## Failure semantics

Infrastructure failure is separated from experimental failure.

Examples of infrastructure failure kinds:

- `worker_environment`
- `source_checkout`
- `dependency_install`
- `environment_compile`
- `agent_harness`
- `model_provider`
- `verification_infrastructure`

A verifier command returning non-zero after a successful agent run is an experimental arm outcome (`fail`), not an infrastructure failure.

## MCP surface

- `workspace_status`
- `list_experiments`
- `get_experiment`
- `start_experiment`
- `get_run_status`
- `get_run`
- `get_run_artifacts`
- `list_runs`

`list_experiments` returns an object containing the available experiment definitions and their environment versions.

`start_experiment` accepts environment ids in `arms`. It also accepts an optional exact `subjectSha`; otherwise it resolves the configured subject branch and freezes its current GitHub SHA before queueing the run.
