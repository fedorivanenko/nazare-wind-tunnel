# Nazare Wind Tunnel

Nazare Wind Tunnel runs exact source revisions through an eve coding agent in hardware-isolated, repository-scoped Vercel Sandboxes.

## Production architecture

```text
GitHub pull request
        |
        | manual workflow_dispatch
        v
GitHub Action
  - resolves exact PR SHA
  - validates task spec
        |
        v
Wind Tunnel run API + PostgreSQL registry
        |
        v
Vercel eve Workflow
        |
        +-- one durable session and sandbox per repository
        +-- persistent source mirror, checkout, and keyed preparation cache
        +-- model edits and deterministic verification
        +-- PostgreSQL event mirror: runs, model activity, tools, evidence
```

Vercel is the only runtime. The former Railway API, worker, PostgreSQL queue, storage adapters, and Docker deployment path have been removed.

## Security boundary

GitHub Action sends exact candidate repository and SHA. Repository continuation identity is the repository slug, so later tasks reuse the same durable eve session and Vercel Sandbox. Sandbox receives no GitHub, Vercel, control-plane, database, or object-storage credentials; source repositories must therefore be publicly cloneable until credential brokering is configured.

Inside sandbox:

1. A preflight hook fetches exact SHA into persistent `/workspace/source.git`.
2. It resets persistent `/workspace/repo` to that immutable baseline.
3. It runs task preparation only when repository, SHA, or preparation commands change.
4. Network changes to `deny-all` before model execution.
5. Agent mutates candidate.
6. `finish_run` captures binary patch and runs deterministic verification in same checkout.
7. Next task clears model context and resets checkout while preserving sandbox and prepared dependencies.

Agent cannot push or access credentials.

## eve agent

Pinned runtime:

```text
eve 0.52.5
model openai/gpt-oss-120b
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
[target-manifest tools]
```

Agent definition lives under `agent/`:

```text
agent/
  agent.ts
  instructions.md
  sandbox/sandbox.ts
  channels/
  hooks/
  instructions/
  lib/
  tools/
```

## Experiment contract

Subject repository owns task, preparation, and model-assistance tools. Wind Tunnel owns versioned trusted evaluators:

```json
{
  "id": "marketing-consent-02",
  "taskFile": "experiments/luna-operability/task-02-marketing-consent.md",
  "evaluator": "marketing-consent-v2",
  "allowedPaths": ["app"],
  "agent": {
    "provider": "vercel-ai-gateway",
    "model": "openai/gpt-oss-120b",
    "thinking": "low",
    "timeoutMs": 30000
  },
  "tools": {
    "bootstrap": [{
      "id": "task-context",
      "entrypoint": ".wind-tunnel/prepare-change.ts",
      "timeoutMs": 3000,
      "maxOutputBytes": 24000,
      "required": true
    }]
  }
}
```

Model selection now belongs to `agent/agent.ts`; experiment `agent` fields remain compatibility metadata during migration.

## Deployment

Vercel project:

```text
fedor-studio/nazare-wind-tunnel
https://nazare-wind-tunnel.vercel.app
```

Commands:

```bash
pnpm install
pnpm exec eve info
pnpm build
pnpm deploy
```

`eve build` creates Vercel Workflow/web output and prewarms reusable Vercel Sandbox template. Project is connected to `fedorivanenko/nazare-wind-tunnel`; pushes to `main` deploy automatically.

## Dashboard

The Astro dashboard reads the PostgreSQL-backed run registry and durable eve session streams through a server-side authenticated proxy. It automatically lists runs and shows execution status, model/tool activity, verification evidence, changed files, and raw redacted events.

```text
fedor-studio/nazare-wind-tunnel-dashboard
https://nazare-wind-tunnel-dashboard.vercel.app
```

The dashboard is a separate Vercel project connected to the same repository with root directory `apps/dashboard`. It deploys automatically on pushes to `main`. Access is protected by `DASHBOARD_ACCESS_TOKEN`; `WIND_TUNNEL_TOKEN` never reaches the browser.

## Required configuration

eve project production environment:

```text
WIND_TUNNEL_TOKEN
DATABASE_URL
```

Dashboard project production environment:

```text
EVE_WIND_TUNNEL_URL
WIND_TUNNEL_TOKEN
DASHBOARD_ACCESS_TOKEN
```

Vercel project OIDC authenticates eve to AI Gateway automatically; no model-provider secret is configured.

Hydrogen GitHub repository:

```text
Actions variable:
EVE_WIND_TUNNEL_URL=https://nazare-wind-tunnel.vercel.app

Actions secret:
WIND_TUNNEL_TOKEN
```

No GitHub deploy key/token is needed by eve. GitHub Action already has read access to private source and uploads credential-free archive.

## Trigger

From GitHub Actions, run **Run eve Wind Tunnel** with:

```text
pr=<same-repository PR number>
task=experiments/luna-operability/task-02-marketing-consent.json
```

Workflow uploads redacted eve NDJSON events plus compact result JSON as private GitHub Actions artifacts.

For local invocation against deployed agent:

```bash
git -C /path/to/subject archive --format=tar.gz --output=/tmp/source.tar.gz HEAD
EVE_WIND_TUNNEL_URL=https://nazare-wind-tunnel.vercel.app \
WIND_TUNNEL_TOKEN=... \
SUBJECT_REPO=owner/repository \
SUBJECT_SHA=$(git -C /path/to/subject rev-parse HEAD) \
EXPERIMENT=experiments/path/experiment.json \
SUBJECT_ARCHIVE=/tmp/source.tar.gz \
node scripts/run-eve-wind-tunnel.mjs
```

## Repository layout

```text
agent/                  eve agent, channel, sandbox, and tools
apps/dashboard/         authenticated Astro dashboard
scripts/                GitHub/local eve client
.github/workflows/      validation
```
