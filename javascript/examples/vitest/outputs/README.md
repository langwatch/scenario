# Voice demo outputs (TypeScript)

This directory holds the on-disk artifacts produced by the TypeScript voice
port's `@e2e` demo tests under `javascript/examples/vitest/tests/voice/`. One
subdirectory per artifact type — today:

- [`recordings/`](./recordings/README.md) — canonical audio (`full.wav`),
  per-turn `segments/`, and `manifest.json` for every committed demo. This is
  the "prove it" audio evidence (issue #372).

Reserved for future artifact types (not present today, but the shape is meant
to accommodate them without another rename):

- `traces/` — OpenTelemetry / scenario-event traces.
- `logs/` — captured stdout/stderr per demo run.
- `screenshots/` — UI capture for the (eventual) browser-driven demos.

See [`recordings/README.md`](./recordings/README.md) for the audio commit
policy, per-demo coverage table, and how the recordings are produced.
