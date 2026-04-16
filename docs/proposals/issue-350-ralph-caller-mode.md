# Ralph Prompt — Issue #350, Follow-up: Caller Mode + Two-Number Automation

Previous ralph (`issue-350-ralph-real-transports.md`) shipped `TwilioAgentAdapter` + `PipecatAgentAdapter` with real transports. This follow-up closes two gaps surfaced in review:

1. **Primary use case: testing a prod voice agent without touching its code.** User has a voice agent wired to a Twilio number in prod (e.g. `+1-555-SUPPORT`). Scenario must let them dial *into* that number as a simulated customer — without modifying the agent, its webhook, or its deployment. The simulator *is* the caller. The prod agent answers naturally.
2. **Automated two-number self-test.** With two Twilio numbers we can exercise the full transport end-to-end in CI-adjacent smokes, no human phone required. This removes the "user has to pick up their cell" step from smoke 3.

**Done when** `scenario.voice` exposes a first-class caller primitive that dials any E.164 number over Twilio, streams PCM as a simulated customer, and `TwilioAgentAdapter` supports both the existing "agent answers the call" mode and a new "simulator originates the call" mode — bridged across real PSTN when both ends are Twilio numbers this adapter owns.

## What scenario is (and what that means for this design)

Scenario is a **testing harness**. Its contract: given an adapter that transports audio to/from an agent-under-test, drive a user-simulator against it and produce a judged `ScenarioResult`. Scenario does not run the agent; it runs the simulator and observes.

That framing means:

- **The adapter is the seam between scenario and the real world.** Everything phone-specific lives on the adapter. `ScenarioExecutor` and `UserSimulatorAgent` stay transport-agnostic.
- **"Who calls who" is a transport concern, not a scenario concern.** The adapter exposes `connect()`, `send_audio()`, `recv_audio()`, `disconnect()` — the scenario doesn't care which side initiated the PSTN leg. It only cares that audio flows bidirectionally once `connect()` returns.
- **Prod agents are untouchable black boxes.** Scenario cannot require the user to swap their webhook, wrap their bot, or run a pipecat sidecar. The only affordance scenario has over a prod agent is its phone number.
- **"The call" is the transport session, not the test.** A scenario can span multiple `call()` turns within one PSTN leg; it can also run without any PSTN at all (in-process bridge for two-adapter tests).

This yields two distinct primitives:

| Primitive | Who runs it | What it does |
|-----------|-------------|--------------|
| `TwilioAgentAdapter(mode="answer")` | Scenario (existing) | Answers inbound calls on a Twilio number it owns. Used when the *agent-under-test* is the scenario side. |
| `TwilioCallerAdapter` or `TwilioAgentAdapter(mode="call")` | Scenario (**new**) | Places outbound calls to any E.164 number. The simulator streams as the *caller*. Used when the *agent-under-test is external* (e.g. a prod voice agent). |

These are functionally distinct — one answers, one originates — but they share everything below the surface: webhook server, Media Streams WS handler, µ-law codec, REST helper, tunnel. Same base class, same test seams.

## Scope

### Ship

1. **Caller mode on `TwilioAgentAdapter`.** New method `place_call(to=..., from_=...)` where `from_` is a Twilio number this adapter owns and `to` is any E.164 target. The WS leg opened by `<Connect><Stream>` is the caller's side — what the *callee* hears comes from our `send_audio`; what *we* hear from the callee arrives via `recv_audio`. Simulator drives send/recv; the callee is the external agent.
2. **Two-number bridged smoke.** Rewrite the broken `voice_twilio_self_call_smoke.py` to use *two adapters on two numbers*, where one places the call and the other answers. Asserts µ-law flows caller→callee and callee→caller over real PSTN. No human required.
3. **Documented prod-agent recipe.** `docs/voice-twilio.md` section: "How to test a prod voice agent." Recipe: buy one Twilio number for scenario, call your prod number from it, run simulator. Ten lines, code snippet included.
4. **Rename the existing smokes to reflect semantic direction.** `voice_twilio_inbound_scenario.py` → `voice_twilio_agent_answers_scenario.py` (agent-under-test answers). `voice_twilio_outbound_scenario.py` → `voice_twilio_simulator_calls_human_scenario.py` (simulator dials a human's cell). The new two-number smoke: `voice_twilio_simulator_calls_agent_scenario.py`.

### Do not ship (file as follow-ups)

- `<Dial>`-based three-way PSTN bridging where one Twilio number bridges caller↔callee with scenario in the middle tapping both legs. Useful for "record both sides of a real support call" — specialist use case, not this PR.
- SIP-trunk targets (non-Twilio callees). E.164 over Twilio REST covers the 90% case.
- Parallel calls from one adapter (multiple concurrent `place_call`s). One call per adapter instance; spin up more adapters if you need more calls.

## Key design question: one class or two?

**Answer: one class, one method per direction.** `TwilioAgentAdapter` stays a single class. It exposes `wait_for_call()` for answer mode and `place_call(to=..., from_=...)` for caller mode. Calling both in the same session is an error (`RuntimeError`: "adapter is in {mode} mode"). The choice is made at first-method-call time, not at construction time, because:

- Construction just sets up creds + public_base_url; direction is irrelevant.
- Mode is determined by which method the scenario calls first.
- One class = one import, one test surface, one docs page.
- Transport internals (WS server, codec, REST) are 100% shared.

**Why not a separate `TwilioCallerAdapter` class?** Because "caller" and "answerer" differ only in:
- Which TwiML is served (answer: `<Connect><Stream>` on inbound webhook hit; caller: same, but triggered by our REST `calls.create()` with `url=twiml_url`).
- Whether we read+restore the Twilio number's `voice_url` (answer mode: yes; caller mode: only if we're using a number that normally answers for something else — usually no).

Both are small branches inside `connect()`/`place_call()`. Extracting a whole class for them is SRP cosplay; the *responsibility* (transport Twilio audio) is the same.

**But** — if review disagrees, the fallback is two thin classes sharing a `_TwilioBase` with all the real logic. Don't fight this if a reviewer pushes back; the internal module structure is the same either way.

## SRP decomposition

| Module | Responsibility | Lines (target) |
|--------|----------------|----------------|
| `_twilio_shared.py` (exists) | µ-law↔PCM16 codec, Media Streams frame parser, REST wrapper, E.164 validation | ~260 (unchanged) |
| `twilio.py` (exists, extended) | `TwilioAgentAdapter` — ties webhook server + WS handler + REST client + tunnel into the `VoiceAgentAdapter` interface. Now supports both answer and caller modes. | ~500 (currently ~413) |
| `testing/twilio_harness.py` (exists) | Composes cloudflared tunnel + adapter connect/disconnect for smokes | unchanged |
| `examples/voice_twilio_simulator_calls_agent_scenario.py` (new) | Two-number smoke: adapter A places call, adapter B answers, audio round-trips | new, ~120 lines |

**What does NOT change:**
- `ScenarioExecutor` — no caller/answerer conditionals.
- `UserSimulatorAgent` — no phone awareness.
- `VoiceAgentAdapter` base — no new abstract methods; `place_call`/`wait_for_call` stay adapter-specific.
- `PipecatAgentAdapter` — separate adapter, separate concerns.
- `AudioChunk`, recording, effects — unchanged.

## Contract: `TwilioAgentAdapter.place_call()`

```python
async def place_call(
    self,
    to: str,                  # E.164 target — prod agent's number, a cell, anything
    *,
    timeout: float = 30.0,    # wait for media stream to go live
) -> None:
    """
    Originate an outbound call from this adapter's Twilio number to `to`.

    After this returns, the adapter is in a live bidirectional audio session:
    - send_audio(chunk) → plays into the callee's ear (the simulator talks)
    - recv_audio() → what the callee says back (the agent responds)

    The callee can be:
    - Another Twilio number owned by any adapter (two-number self-tests).
    - A real cell phone (human-in-the-loop smokes).
    - A prod voice agent on any Twilio/SIP/PSTN endpoint reachable by E.164.

    Blocks until Twilio opens the Media Streams WS back to our `/twilio/stream`
    endpoint, i.e. until the callee has accepted and audio can flow.

    Raises RuntimeError if called after wait_for_call() (modes are exclusive).
    Raises TimeoutError if the media stream doesn't open within `timeout`.
    """
```

**Semantics already right in current code.** What changes:
- Remove the implicit assumption that the *caller's* Twilio number stays in its prior inbound-webhook configuration untouched. Caller mode doesn't need to modify `voice_url` at all — Twilio uses the `url=` param we pass to `calls.create()` directly. Skip the read/restore dance when in caller mode.
- Add a `_mode: Literal["idle", "answer", "call"]` state attribute. `_mode` transitions idle → answer on `wait_for_call()`, idle → call on `place_call()`. Second transition raises.
- Update `connect()`: always start server + tunnel, but only write `voice_url` when answer mode is entered. This means `connect()` stops modifying the Twilio account's state — mode entry does.

**Subtle but important:** the caller's Twilio number can be "just" a number we own; it doesn't need a reserved inbound webhook. This makes caller-mode adapters safe to run against a shared pool of Twilio numbers without clobbering anyone's prod webhook.

## Two-number smoke design

`voice_twilio_simulator_calls_agent_scenario.py`:

1. Spin up two `TwilioHarness` instances on different ports (8765, 8766). Each gets its own cloudflared tunnel.
2. Adapter B (`wait_for_call()` on `TWILIO_PHONE_NUMBER`) — the "agent-under-test" stand-in. It plays back a canned greeting and echoes caller audio.
3. Adapter A (`place_call(to=TWILIO_PHONE_NUMBER)` from `TWILIO_PHONE_NUMBER_2`) — the simulator.
4. Handshake: `wait_for_call` and `place_call` run concurrently. Twilio dispatches the inbound call to B's webhook → B returns `<Connect><Stream>` TwiML → Twilio opens WS back to B. Meanwhile A's `place_call` REST call returned a call SID; Twilio rings the callee (B's number), B's webhook fires, B's WS leg opens, A's WS leg opens. Both `_stream_connected` events fire.
5. A sends a 440Hz PCM tone via `send_audio`. Assert B receives non-silent µ-law via `recv_audio` within 5 seconds.
6. B sends a distinct 880Hz tone back. Assert A receives it.
7. Cleanup: both adapters disconnect; webhooks restored; tunnels torn down.

**Cost:** ~$0.02/min × 2 legs × 30s call ≈ $0.02/run. Cheap enough for manual smokes, expensive enough to not run in every CI job.

**Why this works where the broken self-call didn't:** the old smoke had *one* adapter trying to be both caller and callee. That can't work — `<Connect><Stream>` terminates the TwiML execution on the caller's leg, so there's no way to also `<Dial>` the callee. Two adapters on two numbers is the right topology: each is a full answerer or caller, Twilio bridges them over PSTN naturally.

## Prod-agent recipe (docs)

Add to `docs/voice-twilio.md`:

```markdown
## Testing a prod voice agent

Your agent runs in prod on `+1-555-YOUR-AGENT`. You want to bench it with
scenario without touching its webhook, deployment, or code. Buy one Twilio
number for scenario (say `+1-555-SCENARIO`) and run:

```python
import scenario
from scenario.voice import TwilioAgentAdapter
from scenario.voice.testing import TwilioHarness

async with TwilioHarness(
    account_sid=...,
    auth_token=...,
    phone_number="+15555CENARIO",  # scenario's own number (caller)
) as caller:
    await caller.place_call(to="+15555YOURAGENT")  # dials prod agent
    result = await scenario.run(
        name="prod agent handles a return",
        description="Customer wants to return a defective product.",
        agents=[caller, scenario.UserSimulatorAgent(...), scenario.JudgeAgent(...)],
    )
    print(result)
```

That's the whole setup. Your prod agent is untouched; scenario dials it as a
simulated customer and produces a judged transcript.
```

Ten lines of setup. No webhook swaps, no staging deploy, no pipecat sidecar.

## Testing strategy (SRP and the pyramid)

### Unit tests (mocked Twilio REST, no tunnel, no real WS)

Add to `python/tests/voice/test_twilio_adapter.py`:

1. `test_place_call_transitions_to_call_mode` — mock REST, call `place_call`, assert `_mode == "call"`.
2. `test_wait_for_call_then_place_call_raises` — mode exclusivity.
3. `test_place_call_then_wait_for_call_raises` — same, other direction.
4. `test_place_call_does_not_modify_voice_url` — REST mock records `write_voice_url` calls; assert none happened in caller mode.
5. `test_wait_for_call_does_modify_voice_url` — converse; answer mode still writes.
6. `test_place_call_passes_twiml_url_to_rest` — REST mock captures `calls.create` kwargs; assert `url` matches `public_base_url + "/twilio/voice"`.
7. `test_place_call_timeout_raises` — `_stream_connected` never fires; `asyncio.TimeoutError` propagates.

### Integration tests (two adapters, in-process, no Twilio)

New file `python/tests/voice/test_twilio_two_adapter_bridge.py`: spin up two `TwilioAgentAdapter` instances, *mock Twilio's side* by directly connecting their WebSocket endpoints to each other (loopback the Media Streams frames), and verify audio round-trips. This proves the WS-frame protocol is symmetric without spending money.

- `test_two_adapters_exchange_audio_via_loopback` — A's `send_audio` surfaces in B's `recv_audio`, µ-law frames pass through parser/serializer roundtrip.
- `test_dtmf_loopback` — A sends DTMF via REST mock, B's `on_dtmf` fires. (May skip if too fiddly; Media Streams delivers DTMF as events from Twilio's signaling layer, not over the audio WS — a loopback test might not be faithful.)

### Real-transport smokes (manual, `examples/`)

- `voice_twilio_agent_answers_scenario.py` (renamed from inbound) — existing.
- `voice_twilio_simulator_calls_human_scenario.py` (renamed from outbound) — existing.
- `voice_twilio_simulator_calls_agent_scenario.py` (new) — two-number automation.

No markers, no env skips, fail loud if creds missing.

## Non-negotiables

1. **One class.** `TwilioAgentAdapter` is the only Twilio class. No `TwilioCallerAdapter` sibling unless review specifically demands it (and even then, prefer composition via `_TwilioBase`).
2. **Mode is dynamic, not constructor-param.** No `mode="call"` kwarg. The first `place_call`/`wait_for_call` call determines direction. Construction is direction-free.
3. **Caller mode leaves the Twilio account unchanged.** No `voice_url` writes. No webhook registration on the caller's number. Verify with the unit test suite above before marking done.
4. **Scenario-level code stays transport-agnostic.** `git diff main -- python/scenario/scenario_executor.py python/scenario/user_simulator_agent.py` after this work shows no changes. If you find yourself editing those files, stop and redesign.
5. **Prod-agent recipe works.** Run the snippet in `docs/voice-twilio.md` against an actual external voice agent (any Twilio trial account's echo test number works, e.g. `+14155992671`) and confirm audio flows. This is the acceptance test for the primary use case.
6. **Two-number smoke passes.** `python examples/voice_twilio_simulator_calls_agent_scenario.py` exits 0. Both tones round-trip. Total cost per run documented.
7. **Delete the broken `voice_twilio_self_call_smoke.py`.** It's uncommitted, never worked, and the two-number smoke supersedes it cleanly. Commit its removal as part of the rename step.
8. **All existing 214 tests stay green.** Baseline: `cd python && uv run pytest tests/ -q` reports 214 passing. Don't regress. New unit tests added to the existing `test_twilio_adapter.py` file; new integration file stands alone.
9. **Pyright clean.** `cd python && uv run pyright .` exits 0. The existing `pyrightconfig.json` excludes the pipecat bot; don't add more exclusions.

## Locked decisions — do not relitigate

Carried forward from PR #355 and the previous ralph:

1. `AudioChunk` is PCM16 @ 24kHz mono. Adapters convert at send/recv.
2. `interrupt(after_words=N)` raises `UnsupportedCapabilityError` on `TwilioAgentAdapter`.
3. Capabilities: `streaming_transcripts=False`, `native_vad=False`, `dtmf=True`, `input/output_formats=["mulaw/8000"]`.
4. No `pipecat` in scenario's deps.
5. cloudflared quick tunnels only.
6. `TwilioAgentAdapter.__repr__` redacts `account_sid` and `auth_token`. Preserve.
7. Hard deps: `twilio>=9.0`, `fastapi>=0.110`, `uvicorn>=0.27`. No optional extras.

## Convergence checks

After each pass, in order:

1. `cd python && uv run pytest tests/ -q` — 214+ passing (new tests add to baseline).
2. `cd python && uv run pyright .` — exit 0.
3. `grep -rn "_mode" python/scenario/voice/adapters/twilio.py` — the new mode tracking is present.
4. `grep -rn "voice_url" python/scenario/voice/adapters/twilio.py` — writes guarded by answer-mode check.
5. `git diff main -- python/scenario/scenario_executor.py python/scenario/user_simulator_agent.py` — empty.
6. `python -c "from scenario.voice import TwilioAgentAdapter; help(TwilioAgentAdapter.place_call)"` — docstring matches the contract above.
7. Two-number smoke passes end-to-end: `python examples/voice_twilio_simulator_calls_agent_scenario.py` exits 0.
8. Prod-agent recipe works: invoke scenario against Twilio's echo test (`+14155992671`) — audio round-trip observed, scenario runs to completion, `ScenarioResult` has non-empty transcript.

## Credentials

`python/.env` has:
- `OPENAI_API_KEY`
- `TWILIO_ACCOUNT_SID` (redacted — ask the repo owner)
- `TWILIO_AUTH_TOKEN` (redacted — ask the repo owner)
- `TWILIO_PHONE_NUMBER` (primary — the answerer number)
- `TWILIO_PHONE_NUMBER_2` (caller number for the two-number smoke)

Load via `python-dotenv`. Do not log. Do not commit. `__repr__` redacts.

## When to stop

- 214+ existing tests stay green; pyright clean.
- `TwilioAgentAdapter.place_call()` works as a prod-agent-testing primitive, with caller mode leaving the Twilio account unchanged.
- Two-number automated smoke exits 0 — both µ-law legs round-trip without human involvement.
- Prod-agent recipe in `docs/voice-twilio.md` runs against Twilio's echo test successfully.
- Broken `voice_twilio_self_call_smoke.py` is gone.
- Existing smokes renamed to reflect semantic direction.
- PR body updated to describe the caller-mode feature and the prod-agent recipe as the primary use case.
- No new top-level scenario APIs. No `ScenarioExecutor` changes. No `UserSimulatorAgent` changes.

## Anti-goals — if you find yourself doing any of these, STOP

- Adding a `direction=` or `mode=` constructor kwarg. Mode is implicit.
- Introducing `ScenarioExecutor.call_phone()` or similar. Scenario doesn't know about phones.
- Subclassing `TwilioAgentAdapter` into `TwilioCallerAdapter` and `TwilioAnswererAdapter`. One class.
- Adding `pipecat` imports anywhere in `scenario.voice.*`. User-installed only.
- Making the smoke "use the pytest runner." It's a real-transport smoke, not a unit test. Lives in `examples/`, runs as `python examples/...`.
- Building `<Dial>`-based bridging into the adapter. Different topology, different PR.
