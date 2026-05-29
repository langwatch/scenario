# Test-run outputs

Parent directory for all artifacts produced by voice demo/test runs.
Each artifact type lives in its own subdirectory so the tree stays
navigable as new types are added.

## Layout

```
outputs/
  recordings/      # Per-demo audio + manifests. See recordings/README.md.
  scenario.log     # Optional run-level log (set SCENARIO_LOG_FILE).
  # Future: traces/, screenshots/, etc.
```

## What's checked in

Most files here are produced per local run and gitignored. The
exception is the committed PR-evidence subset under `recordings/` —
see `recordings/README.md` for the table and the rationale.

## Why a parent dir?

Recordings are one artifact type today, but the same demos will
eventually emit OTEL traces, structured logs, and visual snapshots.
A single `outputs/` parent keeps those grouped (one ignore prefix,
one CI upload path) while letting each type's subdir own its own
README and conventions.
