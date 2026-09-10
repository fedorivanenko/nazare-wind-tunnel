# Nazare Wind Tunnel

Nazare Wind Tunnel is a persistent testing environment that pins a subject repository and agent configuration, gives the model an explicit toolset, and measures task effectiveness.

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
  "experiment": ".wind-tunnel/hydrogen-operability/experiment.json"
}
```

The API stores the immutable request in Postgres and returns immediately. Experiment configuration pins provider, model, thinking level, timeout, verification, enabled tool names, and repo-relative Pi extensions:

```json
{
  "id": "marketing-consent-02",
  "taskFile": "experiments/task.md",
  "agent": {
    "provider": "vercel-ai-gateway",
    "model": "openai/gpt-oss-20b",
    "thinking": "low",
    "timeoutMs": 30000
  },
  "tools": {
    "allow": ["read", "bash", "edit", "write", "project_search"],
    "extensions": [".wind-tunnel/project-tools.ts"],
    "bootstrap": [{
      "id": "task-context",
      "entrypoint": ".wind-tunnel/prepare-change.ts",
      "timeoutMs": 3000,
      "maxOutputBytes": 24000,
      "required": true
    }]
  },
  "verification": ["pnpm test"]
}
```

Pi starts with ambient extensions, skills, prompt templates, and context files disabled. Only declared tools and extensions load. If `tools` is omitted, fixed defaults are `read`, `bash`, `edit`, and `write` with no bootstrap providers.

Before model launch, worker loads declared extensions and records effective custom-tool descriptions and JSON schemas. Missing, duplicate, or unloadable allowlisted tools fail preflight. Bootstrap entrypoints execute through `pnpm exec tsx` with task JSON on stdin. Their bounded JSON output becomes pinned prompt context and an artifact. Bootstrap work is measured separately from model-initiated tool calls.

## Persistent subject cache

On the first run for a repository, the worker clones it into:

```text
/workspace/repos/<owner>/<repo>
```

Later runs reuse the same trusted Git/dependency cache. Worker fetches only requested commit, resets trusted cache, then exports a `.git`-free per-run workspace:

```text
git fetch --no-tags --force origin <sourceSha>
git reset --hard <sourceSha>
git clean -fdx -e node_modules/
git archive <sourceSha> → /workspace/runs/<runId>/subject
```

Pi, bootstrap, and verification run in isolated export. Candidate patch capture uses trusted Git directory with temporary index after Pi exits.

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
WIND_TUNNEL_ALLOWED_MODELS_JSON=["vercel-ai-gateway:openai/gpt-oss-20b","vercel-ai-gateway:openai/gpt-oss-120b"]
```

Private subjects additionally require worker-only fine-grained GitHub token with read-only repository contents access:

```text
WIND_TUNNEL_GITHUB_TOKEN
```

Git authentication travels through process environment configuration, never URL/arguments/logs. Pi and subject-code subprocesses receive sanitized environments without database, object-storage, control-plane, or GitHub credentials.

Model/provider credentials required by Pi also belong on the worker service. Vercel AI Gateway uses `AI_GATEWAY_API_KEY`.

Optional observability configuration:

```text
WIND_TUNNEL_PROVIDER_PROBE_TIMEOUT_MS=5000
WIND_TUNNEL_AGENT_STARTUP_TIMEOUT_MS=15000
WIND_TUNNEL_AGENT_IDLE_TIMEOUT_MS=60000
```

Before Pi starts, worker performs an authenticated provider/model probe, inspects declared tool schemas, hashes extensions/bootstrap providers, and executes required deterministic context providers. Pi runs with `--offline` to skip startup catalog/version network operations; model inference remains online. PostgreSQL stores lifecycle, batched conversation, tool, workspace, and verification events. Full Pi JSONL remains in S3. Every outcome—including timeout and cancellation—captures `patch.diff` and `changed-files.txt` before cleanup. `environment.json` and `tool-manifest.json` record pinned execution evidence. Timeout diagnostics include Pi stdout/stderr, `agent-diagnostics.json`, and a redacted Node diagnostic report when Pi can produce one.

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
