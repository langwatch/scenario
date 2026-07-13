# Testing Philosophy

## Hierarchy

| Level           | Purpose                       | Mocking                  |
| --------------- | ----------------------------- | ------------------------ |
| **E2E**         | Happy paths via real examples | None                     |
| **Integration** | Edge cases, error handling    | External boundaries only |
| **Unit**        | Pure logic, branches          | Everything               |

### Language-Specific Patterns

| Language   | E2E             | Integration             | Unit             | Location     |
| ---------- | --------------- | ----------------------- | ---------------- | ------------ |
| TypeScript | `*.e2e.test.ts` | `*.integration.test.ts` | `*.unit.test.ts` | `__tests__/` |
| Python     | `test_*_e2e.py` | `test_*_integration.py` | `test_*.py`      | `tests/`     |
| Go         | `*_e2e_test.go` | `*_integration_test.go` | `*_test.go`      | same package |

## Workflow

1. **Spec first**: Write a `.feature` file in `specs/`. Use tags: `@e2e`, `@integration`, `@unit`.
2. **Challenge**: LLM/reviewer challenges missing edge cases before implementation.
3. **Examples drive E2E**: Working examples in `examples/` are wrapped by e2e tests.
4. **Implement**: Outside-in test driven (TDD). Red → Green → Refactor.

## Decision Tree

```text
Is this a happy path demonstrating SDK usage?
  → E2E (wrap an example)

Does it test orchestration between internal modules or external API behavior?
  → Integration (mock external boundaries)

Is it pure logic or a single class in isolation?
  → Unit (mock collaborators)

Is it a regression from production?
  → Add test at the LOWEST sufficient level (unit > integration > e2e)
```

## Scenario Design

Each scenario should test **one invariant**. When deciding whether to extend an existing scenario or create a new one:

- **Extend** (add `And`/`But`): The new assertion is a natural consequence of the same behavior
- **New scenario**: The assertion tests a distinct invariant that could fail independently

Example: "Cache returns stale data" and "Cache key includes version" are orthogonal invariants — separate scenarios. If one fails, you immediately know which contract broke.

## What We Don't Test

- Type definitions
- Simple pass-throughs with no logic
- Third-party library internals
- Constants/config (unless dynamic)

## Regression Policy

Edge cases not covered upfront are handled via regression tests. When a bug is found:

1. Reproduce with a failing test
2. Add test at the lowest sufficient level
3. Fix and verify green

This keeps the suite lean while ensuring real failures never recur.

## Voice `@e2e` suite — isolation requirement

The voice `@e2e` demos under `python/tests/voice/test_*_e2e.py` are auto-marked
`integration` by `python/tests/voice/conftest.py:pytest_collection_modifyitems`
and the default `python-ci` job deselects them with `-m "not integration"`.
They only run via the on-demand `voice-integration.yml` dispatch.

Several **multi-turn** demos additionally carry the `voice_multiturn` marker.
They MUST run one pytest process each: collecting them together in a single
process wedges the run (issue #491). The marker lets `voice-integration.yml`
deselect them from the bulk run (`-m "not voice_multiturn"`) and execute each in
a fresh process — replacing the earlier `@pytest.mark.skip` markers that left
the `@e2e` contract asserted-but-never-run.

### Root cause (diagnosed in #491)

`scenario.run()` offloads each scenario to a worker thread with a private event
loop and, in that thread's `finally`, calls `event_bus.drain()` synchronously
(`python/scenario/_events/event_bus.py`). `drain()` does an **unbounded**
`self._event_queue.join()` that only returns once the event-bus worker thread
has POSTed every scenario event to the LangWatch telemetry endpoint. Each POST
has a 30s httpx timeout (`event_reporter.py`) and the worker drains events
**serially**, so teardown cost scales with `event_count × up-to-30s` whenever the
endpoint is reachable-but-slow. Multi-turn voice demos emit the most events (one
per turn, plus base64 audio snapshots), so their teardown is the most exposed;
running several in one process compounds it past the 60s per-test timeout and the
process appears wedged.

Confirmed creds-free: point `LANGWATCH_ENDPOINT` at a socket that accepts but
never responds and run any `scenario.run()` — the worker blocks in
`socket.recv_into` (awaiting the HTTP response) while the calling thread blocks in
`event_bus.drain()` → `queue.join()`. Locally the default endpoint fast-refuses,
so the drain returns immediately — which is why the wedge is invisible in
isolation and on a developer box but bites in the integration workflow, where
`LANGWATCH_API_KEY` is set and telemetry actually posts.

Other contributors that per-process isolation also neutralises: background
`asyncio.create_task`s spawned by adapters (Gemini Live `_session_lifetime`,
Twilio webhook server, Cloudflare tunnel subprocess) that aren't fully reaped
between function-scoped event loops, and the `ffmpeg` playback subprocess in
`python/scenario/voice/playback.py` not always exiting cleanly on `.stop()`.

A narrower SDK-level fix — bounding `event_bus.drain()` so telemetry can never
block test teardown indefinitely — is recommended as a follow-up (#791). It changes
the shared event-bus delivery guarantee for *every* `scenario.run()` caller, so it
is tracked separately from this process-isolation resolution.

### Reproducing the drain — creds-free, ~3 minutes

You do not need a LangWatch account. Point the endpoint at a socket that **accepts
but never responds**; any dummy key works, because nothing ever answers.

```python
# blackhole.py — accepts TCP, swallows the request, never writes a response.
import socket, threading, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 9099)); s.listen(128)
def handle(c):
    c.recv(65536)
    while True: time.sleep(3600)   # hold it open, never respond
while True:
    c, _ = s.accept(); threading.Thread(target=handle, args=(c,), daemon=True).start()
```

```bash
python3 blackhole.py &
export LANGWATCH_ENDPOINT=http://127.0.0.1:9099
export LANGWATCH_API_KEY=sk-lw-blackhole-not-a-real-key
pytest -p no:cacheprovider -x python/tests/voice/test_multi_intent_e2e.py --timeout=540
```

**Measured:** that demo takes **27.6s** with telemetry off and **181s** against the
black hole — **+153s of pure teardown**. A stack dump mid-teardown parks at
`event_bus.drain()` → `_event_queue.join()` → `all_tasks_done.wait()`, and the POST
`ReadTimeout`s land **exactly 30s apart**. So: **teardown ≈ `events × 30s`**, serial,
unbounded. That is the number #791 needs.

### Running the multi-turn demos

**Always pass an explicit `--timeout`.** `pytest.ini` sets `timeout = 60` and it
**wins over** `pyproject.toml` (pytest says so: `configfile: pytest.ini (WARNING:
ignoring pytest config in pyproject.toml!)`). Worse, `timeout_method = thread` kills
the **entire pytest process**, not just the slow test — so one demo over the cap
takes the whole suite down with a thread dump, which looks exactly like a hang. Three
of these demos exceed 60s even with telemetry off, and the drain above adds far more.

```bash
# Supported: one process per demo (what voice-integration.yml does).
pytest -p no:cacheprovider -x python/tests/voice/test_long_hold_e2e.py --timeout=540

# …or discover the whole set by marker and loop, one process each:
for f in $(pytest python/tests/voice -m voice_multiturn --collect-only -q \
            | grep '::' | cut -d: -f1 | sort -u); do
  timeout 600 pytest -p no:cacheprovider -x "$f" --timeout=540
done

# Collecting them together in ONE process is not supported — but be precise about
# why: it is not intrinsic. With the cap lifted and telemetry off they complete
# together in ~424s. What kills a shared run is the drain pushing a demo past the
# 60s cap, at which point the thread method destroys the whole process. Per-process
# isolation is defence-in-depth (it caps a pathological drain at one demo instead of
# the suite) — the load-bearing fix is the timeout override.
pytest -m voice_multiturn python/tests/voice/
```
## WAV / Recording File Policy

Committed WAV fixtures (`javascript/examples/vitest/outputs/recordings/`, `python/recordings/`)
are small fixed inputs regenerated by running the voice demo tests with a real API key.
They are committed as binary blobs for offline CI.

**Decision (captured 2026-05-29, issue #582 item 2):** when the total recording
footprint crosses 50 MB, migrate to one of:
- Git LFS — add a `.gitattributes` entry: `*.wav filter=lfs diff=lfs merge=lfs -text`
- `--update-recordings` flag — regenerate on demand and `.gitignore` WAV outputs

Until that threshold is reached, the current approach (small blobs committed directly)
is acceptable. Track footprint via: `du -sh javascript/examples/vitest/outputs/recordings/ python/recordings/`.
