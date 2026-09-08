# Nazare Wind Tunnel

Wind Tunnel searches over versions of the **software environment** until a fixed model can solve a frozen task inside a fixed budget.

The target, task, model, harness, budget, and verifier stay fixed. Only `environment/` changes.

## Architecture

```text
ChatGPT
  |
  | MCP
  v
persistent Railway service
  |
  +-- /workspace/target        nazare-hydrogen @ WIND_TUNNEL_TARGET_SHA
  |      node_modules prepared once and kept warm
  |
  +-- /workspace/environment   clone of this repo, checked out at env/* ref
  |
  +-- /workspace/runs          persistent run artifacts
  |
  +-- fixed runner + benchmark config from deployed main/core commit
```

A run does exactly this:

```text
resolve env branch -> exact SHA
reset target -> frozen SHA
project environment/ -> target/.nazare/
run Pi under fixed time/token/tool-call budget
run deterministic checkers
save patch + transcript + metrics + verifier output
```

## What is fixed

`benchmark/config.json` owns the controls:

- task
- model/provider/thinking
- hard wall-clock budget
- hard tool-call budget
- token budget when Pi exposes usage in JSON events
- allowed Pi tools
- deterministic checkers

Environment branches must not change benchmark controls for a run. They are resolved only for the contents of `environment/`.

## What changes

Use branches for environment strategies, for example:

```text
env/current
env/minimal
env/registry
env/projection
env/repair-spec
```

Each run records the exact commit SHA behind the supplied environment ref.

## MCP

The deployed service exposes only:

- `workspace_status()`
- `run_test(environmentRef?)`
- `get_run(runId)`
- `get_latest_run()`
- `list_runs(limit?)`

## Required Railway configuration

Mount one persistent volume at `/workspace` and set:

```text
WIND_TUNNEL_TOKEN=...
WIND_TUNNEL_TARGET_SHA=<exact 40-char nazare-hydrogen SHA>
WIND_TUNNEL_TARGET_REPO=fedorivanenko/nazare-hydrogen
WIND_TUNNEL_ENV_REPO=fedorivanenko/nazare-wind-tunnel
WIND_TUNNEL_ENV_REF=env/current
AI_GATEWAY_API_KEY=...
```

Build with `Dockerfile.control`. There is no worker, Postgres, S3, queue, or per-run dependency install in the active design.

On service startup the target is cloned/reset and `npm ci` is run only when the frozen target lockfile does not match the prepared `node_modules` marker. Subsequent runs reuse the prepared dependencies.

## Iteration loop

```text
edit environment branch
commit
run_test("env/my-idea")
inspect result + patch + transcript
change environment
repeat
```

The optimization target is **verified task success inside the fixed budget**.
