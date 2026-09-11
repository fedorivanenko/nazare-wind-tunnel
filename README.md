# Nazare Wind Tunnel

Nazare Wind Tunnel runs an exact public Git revision through an eve coding agent in a repository-scoped Vercel Sandbox. Agent edits candidate, executes deterministic checks, and stores patch, evidence, timing, and event history in PostgreSQL.

## Architecture

```text
API client or GitHub Action
  -> POST /api/runs with repository, SHA, and task
  -> repository-scoped eve session and Vercel Sandbox
  -> persistent mirror, checkout, pnpm store, and preparation cache
  -> model mutation with network denied
  -> deterministic verification
  -> PostgreSQL run and event registry
  -> dashboard
```

Vercel is only runtime. Each repository reuses one durable eve workspace and sandbox. Every run clears model context and resets checkout to requested SHA while preserving source mirror and prepared dependencies.

## Monorepo

```text
apps/agent/       eve agent, run API, sandbox, tools, and API client
apps/dashboard/   authenticated Astro dashboard
.github/workflows/ci.yml
turbo.json
```

Root commands use pnpm workspaces and Turborepo:

```bash
pnpm install
pnpm typecheck
pnpm check
pnpm test
pnpm build
pnpm dev
```

Run apps separately:

```bash
pnpm agent:dev
pnpm dashboard:dev
```

## Task API

Create run:

```http
POST /api/runs
Authorization: Bearer <WIND_TUNNEL_TOKEN>
Content-Type: application/json
```

```json
{
  "operationId": "unique-idempotency-key",
  "workspaceId": "owner/repository",
  "repository": "owner/repository",
  "sourceSha": "40-character-git-sha",
  "task": {
    "prepare": ["pnpm install --frozen-lockfile"],
    "agent": {
      "prompt": "Implement requested change.",
      "timeoutMs": 60000,
      "maxToolCalls": 24
    },
    "verify": ["pnpm lint", "pnpm test", "pnpm typecheck", "pnpm build"]
  },
  "trigger": {
    "provider": "github-actions"
  }
}
```

Response is `202 Accepted`:

```json
{
  "runId": "uuid",
  "sessionId": "eve-session-id",
  "workspaceId": "owner/repository",
  "taskSha256": "sha256"
}
```

Read run and evidence:

```http
GET /api/runs/:runId
Authorization: Bearer <WIND_TUNNEL_TOKEN>
```

List recent runs:

```http
GET /api/runs?limit=50
Authorization: Bearer <WIND_TUNNEL_TOKEN>
```

`operationId` is idempotency key. Repeating it returns existing run. `workspaceId` must match `repository`, guaranteeing one persistent workspace per repository.

## Local API client

```bash
EVE_WIND_TUNNEL_URL=https://nazare-wind-tunnel.vercel.app \
WIND_TUNNEL_TOKEN=... \
SUBJECT_REPO=owner/repository \
SUBJECT_SHA=$(git -C /path/to/repository rev-parse HEAD) \
EXPERIMENT=/path/to/task.json \
pnpm wind-tunnel
```

Optional variables:

```text
WIND_TUNNEL_OPERATION_ID
EVE_RUN_TIMEOUT_MS
EVE_RESULT_PATH
EVE_EVENTS_PATH
```

Client submits run, polls until terminal state, writes result and events, and exits nonzero unless verification passes.

## Sandbox boundary

1. Fetch exact SHA into persistent `/workspace/source.git`.
2. Reset persistent `/workspace/repo` to immutable baseline.
3. Run preparation only when repository, SHA, or preparation commands changed.
4. Deny network before model execution.
5. Permit only model-facing filesystem and shell tools.
6. Reject changes to `.git`, `.github`, `.wind-tunnel`, dependency directories, build outputs, and generated directories.
7. Temporarily allow `registry.npmjs.org` during verification.
8. Capture binary patch and all check output.

Sandbox receives no GitHub, Vercel, database, or provider credentials. Candidate repository must remain publicly cloneable until authenticated source delivery is implemented.

## Runtime

```text
eve 0.52.5
openai/gpt-oss-120b
reasoning low
Vercel Sandbox: 2 vCPU
pnpm 10.17.1
```

Model-facing tools:

```text
bash
read_file
write_file
grep
finish_run
```

## Deployment

Agent:

```text
Vercel project: fedor-studio/nazare-wind-tunnel
Root directory: apps/agent
URL: https://nazare-wind-tunnel.vercel.app
```

Dashboard:

```text
Vercel project: fedor-studio/nazare-wind-tunnel-dashboard
Root directory: apps/dashboard
URL: https://nazare-wind-tunnel-dashboard.vercel.app
```

Both projects disable preview deployments and enable affected-project skipping. Pushes to `main` deploy changed apps only.

Manual agent deployment from repository root:

```bash
pnpm run deploy
```

## Configuration

Agent production environment:

```text
WIND_TUNNEL_TOKEN
DATABASE_URL
```

Optional persistent pnpm cache drive:

```text
WIND_TUNNEL_PNPM_CACHE_DRIVE
```

Dashboard production environment:

```text
EVE_WIND_TUNNEL_URL
WIND_TUNNEL_TOKEN
DASHBOARD_ACCESS_TOKEN
```

Vercel OIDC authenticates eve to AI Gateway. No model-provider secret is required.

## GitHub Actions

Subject repository workflow resolves exact pull-request SHA, reads task JSON, calls `POST /api/runs`, polls result, and uploads redacted evidence as private Actions artifacts. Configure:

```text
Actions variable:
EVE_WIND_TUNNEL_URL=https://nazare-wind-tunnel.vercel.app

Actions secret:
WIND_TUNNEL_TOKEN
```
