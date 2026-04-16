# Ralph Prompt — Issue #350 Real Transports (PR #355 follow-through)

Wire up **real transports for two voice adapters** so #350 ships a deliverable feature, not a typed interface. All existing tests stay mocked and green; this work adds real-provider paths behind `python/examples/voice_*.py`.

**Done when** a human can both **dial into** a scenario-served phone number (agent-under-test answers) and **be dialed by** scenario (user-simulator calls out), and each produces a recorded, judged `ScenarioResult` with transcripts.

## Roles & topology

- **Agent-under-test** = the phone bot. When it *answers* inbound calls, scenario uses `TwilioAgentAdapter.wait_for_call(...)` or `PipecatAgentAdapter` (WS client to a user-run pipecat bot).
- **User-simulator** = the synthetic caller. When it *places* outbound calls, scenario uses `TwilioAgentAdapter.place_call(to=...)` and routes the user-sim's TTS onto that call's media leg.
- **Same `TwilioAgentAdapter` class handles both directions.** A Twilio number can answer and originate; the adapter mirrors that. No `direction` param, no inbound/outbound subclasses. See "TwilioAgentAdapter design" below.

## Scope

Two adapters move from `PendingTransportError` → real implementation:

1. **`PipecatAgentAdapter`** — WebSocket client to a user-run pipecat bot. Proposal §5.1 canonical path. Supports `transport="websocket"` only in this PR; `transport="webrtc"` (SmallWebRTC) stays on `PendingTransportError` with a follow-up issue filed.
2. **`TwilioAgentAdapter`** — FastAPI webhook + Media Streams WS handler + µ-law↔PCM16 codec + Twilio REST client. Bidirectional: exposes `place_call()` for outbound, `wait_for_call()` for inbound. Both legs share the same WS handler, codec, server, and tunnel.

Remaining seven stubs (**LiveKit, ElevenLabs, Vapi, OpenAIRealtime, GeminiLive, WebRTC, WebSocket**) stay on `PendingTransportError`. File one follow-up issue per adapter, link from the PR body.

## Non-negotiable: rename `*Agent` → `*AgentAdapter` (hard rename, no aliases)

Adapters should be called adapters. Rename in a single focused commit before transport work starts. Hard rename — no deprecation shims, no compat aliases. PR #355 is unmerged, nobody's depending on these names yet.

**Rename list:**
- `PipecatAgent` → `PipecatAgentAdapter`
- `TwilioAgent` → `TwilioAgentAdapter`
- `LiveKitAgent` → `LiveKitAgentAdapter`
- `ElevenLabsAgent` → `ElevenLabsAgentAdapter`
- `VapiAgent` → `VapiAgentAdapter`
- `OpenAIRealtimeAgent` → `OpenAIRealtimeAgentAdapter`
- `GeminiLiveAgent` → `GeminiLiveAgentAdapter`
- `WebRTCAgent` → `WebRTCAgentAdapter`
- `WebSocketAgent` → `WebSocketAgentAdapter`

**Does NOT apply to:**
- `UserSimulatorAgent`, `JudgeAgent`, `RedTeamAgent` — these are agents, not adapters.
- `AgentAdapter` base class — stays as-is.
- `VoiceAgentAdapter` base class — stays as-is.
- `WebSocketProtocol` — a Protocol typing class, not an `*Agent`. Do not touch.

**Files that need updates for the rename:**
- `python/scenario/voice/adapters/*.py` — the class definitions.
- `python/scenario/voice/adapters/__init__.py` — re-exports (9 `*Agent` names).
- `python/scenario/voice/__init__.py` — re-exports (9 `*Agent` names in both imports and `__all__`).
- `python/scenario/__init__.py` — top-level re-exports (9 `*Agent` names in both imports and `__all__`).
- `python/tests/voice/test_adapter_stubs.py` — parametrize list.
- `python/tests/voice/test_adapter_redaction.py` — references `TwilioAgent`, `LiveKitAgent`, `ElevenLabsAgent`, `VapiAgent`.
- `python/tests/voice/test_adapters.py`, `test_capabilities.py`, any other voice test referencing the names.
- `specs/voice-agents.feature` — nine `@unit`/`@integration` scenario names reference the adapter class names (`Scenario: PipecatAgent connects over WebSocket…`, `Scenario: TwilioAgent places an outbound call`, `Scenario: LiveKitAgent joins a room…`, etc.). Rename every one.
- Any docstrings or examples that reference old names.

## TwilioAgentAdapter design — bidirectional, single class

```python
class TwilioAgentAdapter(VoiceAgentAdapter):
    def __init__(
        self,
        *,
        account_sid: str,
        auth_token: str,
        phone_number: str,             # E.164 format, e.g. "+14155551234"; adapter resolves to SID
        public_base_url: Optional[str] = None,       # if None, test harness injects the tunnel URL
        allowed_callers: Optional[list[str]] = None, # E.164 filter for inbound; None = all
        on_dtmf: Optional[Callable[[str], None]] = None,  # fires when callee sends DTMF digits
    ): ...

    # Shared lifecycle
    async def connect(self) -> None: ...      # resolve phone_number_sid, start server + tunnel, register webhook
    async def disconnect(self) -> None: ...   # restore prior voice_url, tear down server + tunnel

    # Direction-specific kickoff
    async def place_call(self, to: str) -> None: ...             # outbound; blocks until media stream is live
    async def wait_for_call(self, timeout: float = 30.0) -> None: ...  # inbound; blocks until someone dials in

    # Post-call-live methods — identical regardless of direction
    async def send_audio(self, chunk: AudioChunk) -> None: ...
    async def recv_audio(self, timeout: float) -> AudioChunk: ...
    async def send_dtmf(self, tones: str) -> None: ...

    def __repr__(self) -> str: ...  # redact auth_token — already redacted in current stub; preserve
```

- `connect()` is direction-agnostic: resolve `phone_number` (validate E.164, look up `phone_number_sid` via `client.incoming_phone_numbers.list(phone_number=...)`, cache), register webhook, start FastAPI server + tunnel. After `connect()`, scenario author calls either `place_call()` or `wait_for_call()`.
- `disconnect()` restores the prior `voice_url` (read at connect, write at disconnect) and tears down server + tunnel. Best-effort on errors — log and continue. A crashed test may leave the webhook misconfigured; document the reset command in `docs/voice-twilio.md`.
- `_twilio_shared.py` (or similar) holds codec (µ-law 8kHz ↔ PCM16 24kHz), Media Streams WS frame protocol, REST wrapper. Shared internal module, not a second adapter class.
- **DTMF events: adapter-level `on_dtmf` callback** passed in the constructor. DTMF is a transport-specific event, so it lives on the adapter, not on `ScenarioExecutor`. Shape mirrors the callback pattern already in `scenario_executor.py` (`on_audio_chunk`, `on_voice_event`), but location is the adapter.

## Non-negotiables

1. **Adapter-first.** Every real-world capability is a `VoiceAgentAdapter` subclass. No transport logic leaks into `ScenarioExecutor`, `UserSimulatorAgent`, or effects. If you find yourself editing those for Twilio-specific reasons, stop and redesign.
2. **No pipecat in scenario's deps.** `PipecatAgentAdapter` speaks pipecat's `WebsocketServerTransport` wire protocol as a client — verify the frame format against pipecat's source (GitHub: `pipecat-ai/pipecat`) before implementing. Do not guess. Users bring pipecat themselves.
3. **All existing tests stay green.** Real-provider smokes live in `python/examples/voice_*.py`, not in `python/tests/`. No new pytest markers, no env gates. Baseline: `pytest python/tests/voice/ --collect-only` reports `167 collected, 4 errors` (pre-existing in `test_recording_signals.py`). Don't regress the 167; fix the 4 only if the fix is cheap.
4. **`AudioChunk` stays PCM16 @ 24kHz mono.** µ-law 8kHz ↔ PCM16 24kHz conversion happens at the adapter send/recv boundary — nowhere else.
5. **Capabilities must be truthful.** Update each adapter's `AdapterCapabilities` ClassVar to match what the real transport actually supports (DTMF, native VAD, streaming transcripts, formats). Current stubs may have aspirational values; bring them in line with real wire behavior.
6. **Method names are `connect`, `disconnect`, `send_audio`, `recv_audio`.** Note `recv` not `receive`. Source of truth: `python/scenario/voice/adapter.py`.

## Dependencies

`python/pyproject.toml` currently lists voice deps: `imageio-ffmpeg>=0.5.0`, `numpy>=1.26`, `webrtcvad-wheels>=2.0`, `websockets>=12`. Verified.

`specs/voice-agents.feature` L9 *claims* the following are also hard deps: `soundfile`, `aiortc`, `twilio`, `livekit`, `livekit-api`, `elevenlabs`. They are **not** actually in `pyproject.toml` — documentation drift. Bring them into alignment as part of this work:

- **Add `twilio>=9.0`** — required for `TwilioAgentAdapter` REST client.
- **Add `fastapi>=0.110`** — required for webhook server. Not listed in the feature file; add to BOTH `pyproject.toml` AND `specs/voice-agents.feature` L9.
- **Do NOT add `aiortc`, `livekit`, `livekit-api`, `elevenlabs`, `soundfile`** in this PR — those belong to adapters left on `PendingTransportError`. Amend `specs/voice-agents.feature` L9 to drop them from the "installed as hard deps" claim until the respective adapters ship. Keep the feature file honest about what's actually installed.

Pin floors consistent with neighbors (`>=` style, matching `openai>=1.88.0` etc.).

## Deliverables

### `PipecatAgentAdapter` — WebSocket client

- Real `connect()`/`send_audio()`/`recv_audio()`/`disconnect()` over `websockets`.
- Frame format: pipecat's `WebsocketServerTransport` protocol. **Read pipecat source before implementing**; do not invent a protocol.
- Honor pipecat's interrupt/cancel frames so `after_words`-style interruptions from the user-sim flow through to the bot.
- `transport="webrtc"` stays on `PendingTransportError`; the error message points at the follow-up issue.

### `TwilioAgentAdapter` — bidirectional

Per the design section above. Specifics:

- FastAPI routes: `POST /twilio/voice` (returns TwiML with `<Connect><Stream url="wss://…/twilio/stream"/></Connect>`) and `WS /twilio/stream` (speaks Media Streams).
- Media Streams frame handling: `media` events (inbound audio) → µ-law decode → PCM16 24kHz → deliver via `recv_audio`. Outbound PCM16 24kHz → µ-law encode → base64 → emit as `media` event. `dtmf` events → fire `on_dtmf` callback. `mark`/`clear` events for interruption.
- Programmatic webhook management: on `connect()`, read current `voice_url` from `client.incoming_phone_numbers(sid).fetch()`, overwrite to `public_base_url + "/twilio/voice"`; on `disconnect()`, write it back. Wrap in try/except with best-effort cleanup.
- `allowed_callers` filter: on incoming-call webhook, reject (TwiML `<Reject/>`) if the `From` number isn't in the list.
- E.164 validation: reject `phone_number` that doesn't match `^\+[1-9]\d{6,14}$` at `__init__` with a clear error.
- Capabilities: `streaming_transcripts=False`, `native_vad=False`, `dtmf=True`, `input_formats=["mulaw/8000"]`, `output_formats=["mulaw/8000"]`.
- `__repr__` redaction: preserved from current stub.

### Code-managed tunnel

- Create `python/scenario/voice/testing/__init__.py` (new subpackage) and `python/scenario/voice/testing/tunnel.py`.
- `tunnel.py`: async context manager that spawns `cloudflared tunnel --url http://localhost:PORT` as a subprocess, parses stdout for the `*.trycloudflare.com` URL, yields it, terminates subprocess on exit (SIGTERM then SIGKILL fallback).
- Feature-detect `cloudflared` on PATH on `__aenter__`. If missing, raise a custom error with install instructions BEFORE any call is attempted: macOS `brew install cloudflared`, Linux link to `https://developers.cloudflare.com/cloudflared/install/` (no `apt install` promise — needs Cloudflare's apt repo).
- No cloudflared account required. Quick tunnels only — ephemeral hostname per run.

### Twilio test harness

- `python/scenario/voice/testing/twilio_harness.py` — async context manager composing tunnel + FastAPI app + Twilio webhook update + teardown, restoring prior `voice_url` on exit (best-effort). Shared by outbound and inbound smoke examples.

### Real-provider files (3 smoke scenarios + 1 system-under-test bot)

Each is a runnable script, keys from `python/.env` via `python-dotenv`, fails loud if keys missing. No markers, no skip-if-env.

- **`python/examples/voice_pipecat_twilio_bot.py`** (system-under-test, not a smoke) — a runnable pipecat bot (Twilio transport → OpenAI Realtime). Clone/adapt from `langwatch/openclaw-phone-assistant`. **This is the only file in the repo that imports pipecat.**
- **Smoke 1: `python/examples/voice_pipecat_scenario.py`** — runs a scenario with `PipecatAgentAdapter(url="ws://localhost:8765/ws")`. Requires the bot above to be running in a separate process. Human dials the bot's Twilio number; scenario records + judges; prints result.
- **Smoke 2: `python/examples/voice_twilio_inbound_scenario.py`** — `TwilioAgentAdapter` + `wait_for_call()`. Human dials in; scenario records + judges.
- **Smoke 3: `python/examples/voice_twilio_outbound_scenario.py`** — `TwilioAgentAdapter` + `place_call(to=YOUR_VERIFIED_NUMBER)`. Scenario places a call to a human's phone; user-sim talks on the outbound leg.
  - **Deterministic assertion:** user-sim's first utterance says "Press 1 then hang up." Scenario awaits `on_dtmf == "1"` with a 60-second timeout. Acknowledges this is a human-in-the-loop test; the timeout is loose to tolerate TTS latency + human reaction time.

### Docs

- `docs/voice-twilio.md` — terse. Tunnel install, Twilio trial restriction (outbound requires Verified Caller ID; inbound has no such restriction), how to run each smoke example, env vars layout, and a "reset Twilio webhook if a test crashed" command. Link openclaw-phone-assistant for the pipecat bot reference.

## Out of scope

- The seven other adapter transports. One follow-up issue per adapter, linked from the PR body.
- `PipecatAgentAdapter(transport="webrtc")`. Follow-up issue.
- Automated CI for real smokes. Manual-only via `examples/`.
- ngrok. Cloudflared only.
- ElevenLabs account setup.
- New feature-file scenarios beyond the rename and any DTMF/answer scenarios required by the new `TwilioAgentAdapter` methods. Goal is to make existing `@integration` scenarios runnable, not expand coverage.

## Locked decisions — do not relitigate

Carried forward from PR #355:

1. `AudioChunk` is PCM16 @ 24kHz mono. Adapters convert at send/recv.
2. TTS cache key: `(text, voice)`. Effects applied post-cache.
3. `interrupt(after_words=N)` raises `UnsupportedCapabilityError` on adapters without streaming transcripts. `TwilioAgentAdapter` fits this case — `streaming_transcripts=False`.
4. Hard deps, no optional extras. Add `twilio` and `fastapi` per "Dependencies" above.
5. Pluggable `STTProvider`, default OpenAI `gpt-4o-transcribe`.
6. VAD fallback: `webrtcvad-wheels` with one-shot per-adapter warning.
7. Playback: `ffmpeg` subprocess (bundled binary).

## Sources (read in order)

1. `specs/voice-agents.feature` — 83 scenarios, every adapter scenario cites source line ranges.
2. `docs/proposals/issue-350-voice-agents-source.md` §5.1 (PipecatAgent, L644–710) and §5.3 (TwilioAgent, L813–890). Use `docs/proposals/issue-350-voice-agents-INDEX.md` to find line ranges.
3. `python/scenario/voice/adapters/pipecat.py` and `twilio.py` — current stubs. Keep responsibilities and public methods (after rename); fill in transport.
4. `python/scenario/voice/adapters/_stub.py` — `PendingTransportError` message shape.
5. `python/scenario/voice/adapter.py` — base class `VoiceAgentAdapter` with `connect`/`disconnect`/`send_audio`/`recv_audio`.
6. `https://github.com/langwatch/openclaw-phone-assistant` — pipecat + Twilio + OpenAI Realtime + cloudflared reference implementation. Lift patterns for the pipecat bot example; do not copy pipecat as a scenario dep.

## Convergence checks

After each pass, in order:

1. **All existing tests pass.** `pytest python/tests/voice/` — baseline `167 passing, 4 collection errors in test_recording_signals.py`. Don't regress the 167.
2. **Rename is complete.** `grep -rn "class.*Agent(VoiceAgentAdapter" python/scenario/voice/adapters/` returns nothing. Only `UserSimulatorAgent`/`JudgeAgent`/`RedTeamAgent` remain as `*Agent` names in the codebase. `grep -rn "Agent[,\"\)\b]" python/scenario/__init__.py` shows only agents, no adapters.
3. **No pipecat in scenario's import graph.** `python -c "import scenario; import sys; assert 'pipecat' not in sys.modules"` passes.
4. **Capability matrices truthful.** For each of `PipecatAgentAdapter` and `TwilioAgentAdapter`, diff the `AdapterCapabilities` ClassVar against what the transport actually does. Fix drift.
5. **Adapter pattern intact.** `git diff main -- python/scenario/scenario_executor.py python/scenario/user_simulator_agent.py` shows no Twilio-specific conditionals or direction-aware branches.
6. **Deps reality matches docs.** `pyproject.toml` voice deps and `specs/voice-agents.feature` L9 "installed as hard deps" list agree after this PR.
7. **Smokes runnable.** Each of the 3 smoke examples runs end-to-end against real Twilio + real OpenAI without raising. Transcripts non-empty. Outbound smoke's DTMF assertion passes with human pressing `1`. Bot example runs and accepts a real inbound call.

## Credentials

`python/.env` already has `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`. `TWILIO_PHONE_NUMBER` is in E.164 format; adapter resolves the `PN…` SID internally. Load via `python-dotenv`. Do not hardcode. Do not echo to logs, test output, or PR descriptions. `TwilioAgentAdapter.__repr__` redacts auth_token; preserve that.

**Trial account note:** outbound calls to non-verified numbers fail. Document in `docs/voice-twilio.md`. Inbound has no such restriction.

## When to stop

- PR #355's 167 passing tests stay green.
- `PipecatAgentAdapter` (websocket) and `TwilioAgentAdapter` (bidirectional) have real transports.
- The other seven stubs stay on `PendingTransportError` with follow-up issues filed and linked in the PR body.
- All 3 smoke examples + the pipecat bot have been run by a human against real Twilio + real OpenAI and produced sensible output. Outbound smoke's DTMF assertion passes.
- PR body's "deferred" table updated: `PipecatAgentAdapter` (websocket) and `TwilioAgentAdapter` marked shipped; other seven linked to follow-up issues.
- Do not mark PR ready for merge until a human confirms both the inbound and outbound smokes worked on a real phone.
