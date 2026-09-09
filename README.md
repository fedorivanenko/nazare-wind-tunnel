# Nazare Wind Tunnel

Nazare Wind Tunnel is a persistent testing environment for running model-backed experiments against external subject repositories such as `fedorivanenko/nazare-hydrogen`.

The Wind Tunnel repository contains the testing machinery. Subject repositories remain separate and are materialized lazily into a persistent Railway volume by repository + exact commit SHA.

## Architecture

```text
GitHub PR in subject repo
        |
        | manual workflow
        v
Wind Tunnel API (Railway)
        |
        v
Postgres queue
        |
        v
Wind Tunnel worker (Railway)
        |
        v
persistent /workspace subject cache
        |
        +-- repos/<owner>/<repo>/.git
        +-- repos/<owner>/<repo>/node_modules
        +-- pnpm-store
        +-- .wind-tunnel/subjects
```

A run is one arm only: `raw` or `nazare`. Historical comparisons are queries over Postgres; execution does not couple two arms together.

## pnpm monorepo

```text
apps/
  api/                    public queue/status API
  worker/                 private long-running experiment worker

packages/
  domain/                 run contracts and lifecycle
  storage/                Postgres queue + S3 artifacts
  subject-manager/        persistent repo cache + dependency reuse
  pi/                     fixed Pi harness adapter
```

`nazare-hydrogen` is not part of this monorepo. It is an external experiment subject.

## Run request

```http
POST /runs
Authorization: Bearer $WIND_TUNNEL_TOKEN
Content-Type: application/json

{
  "repository": "fedorivanenko/nazare-hydrogen",
  "sourceSha": "<exact 40-char PR HEAD SHA>",
  "experiment": ".wind-tunnel/hydrogen-operability/experiment.json",
  "arm": "nazare"
}
```

The API stores the immutable request in Postgres and returns immediately.

## Persistent subject cache

On the first run for a repository, the worker clones it into:

```text
/workspace/repos/<owner>/<repo>
```

Later runs reuse the same clone and `node_modules`:

```text
git fetch --prune origin
git reset --hard <sourceSha>
git clean -fdx -e node_modules/
```

The worker requires `pnpm-lock.yaml`. It hashes the lockfile and only runs:

```text
pnpm install --frozen-lockfile --store-dir /workspace/pnpm-store
```

when dependencies are missing or the lockfile hash changed.

## Railway deployment

Use the same GitHub repository for two Railway services.

### API

```text
Dockerfile: Dockerfile.control
start: pnpm api
public: yes
health: /health
```

### Worker

```text
Dockerfile: Dockerfile.worker
start: pnpm worker
public: no
persistent volume: /workspace
concurrency: 1 per worker
```

Shared infrastructure:

- Postgres for queue, lifecycle and searchable metrics
- S3-compatible artifact bucket for transcripts, patches and verifier output

Hydrogen changes never redeploy Wind Tunnel. Only changes to this repository trigger Railway rebuilds.

## Required variables

Both API and worker:

```text
DATABASE_URL
WIND_TUNNEL_TOKEN
WIND_TUNNEL_S3_BUCKET
WIND_TUNNEL_S3_ENDPOINT
WIND_TUNNEL_S3_REGION
WIND_TUNNEL_S3_ACCESS_KEY
WIND_TUNNEL_S3_SECRET_KEY
```

Worker additionally uses:

```text
WIND_TUNNEL_WORKSPACE=/workspace
WIND_TUNNEL_PNPM_STORE=/workspace/pnpm-store
```

Model/provider credentials required by Pi also belong on the worker service. Vercel AI Gateway uses `AI_GATEWAY_API_KEY`.

Optional observability configuration:

```text
WIND_TUNNEL_PROVIDER_PROBE_TIMEOUT_MS=5000
WIND_TUNNEL_AGENT_STARTUP_TIMEOUT_MS=15000
WIND_TUNNEL_AGENT_IDLE_TIMEOUT_MS=60000
```

Before Pi starts, the worker performs an authenticated provider/model probe. Worker lifecycle, subject commands and Pi process telemetry are emitted as structured JSON to Railway logs and persisted as run events. Timeout diagnostics include Pi stdout/stderr, `agent-diagnostics.json`, and a redacted Node diagnostic report when the Pi runtime can produce one.

## CI

Wind Tunnel CI is automatic, cheap and deterministic:

```text
pnpm install
pnpm typecheck
pnpm test
build API image
build worker image
```

Subject experiments remain manual and model-backed.
