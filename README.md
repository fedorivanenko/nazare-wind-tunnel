# Nazare Wind Tunnel

Nazare Wind Tunnel runs exact private source snapshots through an eve coding agent in hardware-isolated Vercel Sandboxes.

## Production architecture

```text
GitHub pull request
        |
        | manual workflow_dispatch
        v
GitHub Action
  - resolves exact PR SHA
  - validates experiment
  - creates credential-free git archive
        |
        v
Wind Tunnel run API + PostgreSQL registry
        |
        v
Vercel eve Workflow
        |
        +-- mutation sandbox: target preparation, dynamic tools, model edits
        +-- fresh verification sandbox: captured patch + untouched evaluator
        +-- PostgreSQL event mirror: runs, model activity, tools, evidence
```

Vercel is the only runtime. The former Railway API, worker, PostgreSQL queue, storage adapters, and Docker deployment path have been removed.

## Security boundary

GitHub Action checks out exact candidate SHA and uploads `source.tar.gz` as eve attachment. Sandbox receives candidate archive only. It receives no GitHub, Vercel, control-plane, database, or object-storage credentials.

Inside sandbox:

1. `prepare_subject` extracts archive into `/workspace/repo`.
2. It initializes credential-free local Git baseline.
3. It installs dependencies with pinned pnpm `10.17.1`.
4. Network changes to `deny-all` before subject bootstrap/model shell execution.
5. Target-owned tool manifests are validated and exposed dynamically by eve.
6. Agent mutates candidate.
7. `finish_run` captures the binary patch and destroys the mutation sandbox.
8. A fresh sandbox rematerializes exact source, applies only the captured patch, and runs the untouched evaluator.

No clone, fetch, push, or golden reference occurs in agent sandbox.

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
prepare_subject
bash
read_file
write_file
grep
finish_run
```

Agent definition lives under `agent/`:

```text
agent/
  agent.ts
  instructions.md
  sandbox.ts
  channels/eve.ts
  lib/subject.ts
  tools/
```

## Experiment contract

Subject repository owns experiment and task files. Existing experiment JSON remains valid for source preparation, deterministic bootstrap, and verification:

```json
{
  "id": "marketing-consent-02",
  "taskFile": "experiments/luna-operability/task-02-marketing-consent.md",
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
  },
  "verification": [
    {"name":"task-oracle","command":"pnpm exec tsx .wind-tunnel/verify-marketing-consent.ts","required":true}
  ]
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
experiment=experiments/luna-operability/experiment-02-marketing-consent.json
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
