# Issue #350 — Voice Agents Delivery Plan

Authoritative source: `docs/proposals/issue-350-voice-agents-source.md`.
Navigation: `docs/proposals/issue-350-voice-agents-INDEX.md`.
Feature contract: `specs/voice-agents.feature`.

## Scope Summary

Ship a Python-first, single-PR implementation of voice-agent testing inside the Scenario SDK, landing the full §4 Core API (adapters, voice user-simulator, voice-aware judge, script extensions, effects, results, monitoring), the §5 platform adapters, the §6 example tests, and ACs for the five §8 pain patterns. Voice is a first-class feature: audio dependencies install unconditionally (hard deps, no `extras`), with ffmpeg bundled via `imageio-ffmpeg`. TypeScript parity is tracked as a follow-up issue. Existing JavaScript audio code stays in place as reference.

## Phase Breakdown (mirrors Source §10, L1305-1346)

### Phase 1 — Core Voice Primitives (Source §10 L1307-1315)

Files to create:
- `python/scenario/voice/__init__.py` — public exports
- `python/scenario/voice/adapter.py` — `VoiceAgentAdapter(AgentAdapter)` with `connect/disconnect/send_audio/recv_audio` and the default `AgentAdapter.call` impl from §4.1 L216-230
- `python/scenario/voice/audio_chunk.py` — `AudioChunk` dataclass (PCM16 @ 24kHz mono, per Resolved Decision #2), plus helpers `extract_audio`, `create_audio_message`
- `python/scenario/voice/tts.py` — TTS router (litellm-style `"provider/voice"`, §4.2 L271-280), cache keyed on `(text, voice)` only (Resolved Decision #3)
- `python/scenario/voice/stt.py` — pluggable `STTProvider` interface + default OpenAI implementation (Locked Decision #5). Swappable via `scenario.configure(stt=...)`.
- `python/scenario/voice/vad.py` — SDK-side VAD fallback using `webrtcvad-wheels` (Locked Decision #6). Activates when adapter capability matrix has `native_vad=False`; emits one-shot warning on activation.
- `python/scenario/voice/capabilities.py` — `AdapterCapabilities` dataclass + `UnsupportedCapabilityError`. Every adapter publishes a `capabilities` attribute.
- `python/scenario/voice/recording.py` — `VoiceRecording`, `AudioSegment`, `VoiceEvent`, `LatencyMetrics` (§4.6)
- `python/scenario/voice/ffmpeg.py` — thin wrapper around `imageio_ffmpeg.get_ffmpeg_exe()` for format conversion (§4.4 L448, §4.5 L546)

Files to modify:
- `python/scenario/user_simulator_agent.py` — add `voice`, `persona`, `audio_effects`, `interrupt_probability` params; when `voice=` is set, wrap output in TTS+effects pipeline (§4.2 L282-286)
- `python/scenario/judge_agent.py` — auto-detect audio in messages; auto-attach transcripts, timeline, traces; pass audio to multimodal models when supported (§4.3)
- `python/scenario/script.py` — add `sleep`, `silence`, `audio` steps (Phase 1 subset; `interrupt`, `dtmf`, `wait=False` land in Phase 3)
- `python/scenario/types.py` — add `AgentInput.audio`, `AgentInput.timeline`, `AgentInput.traces` optional fields; extend `ScenarioResult` with `audio`, `timeline`, `latency`
- `python/scenario/scenario_executor.py` — lifecycle: call `adapter.connect()` / `adapter.disconnect()` around the script run; build the `VoiceRecording` and timeline during execution
- `python/scenario/__init__.py` — re-export `VoiceAgentAdapter` and new script steps

### Phase 2 — Platform Integrations (Source §10 L1317-1324)

Files to create (one adapter each):
- `python/scenario/voice/adapters/pipecat.py` — `PipecatAgent` (WebSocket + WebRTC, §5.1)
- `python/scenario/voice/adapters/livekit.py` — `LiveKitAgent` (§5.2)
- `python/scenario/voice/adapters/twilio.py` — `TwilioAgent` (outbound call + Media Streams, §5.3)
- `python/scenario/voice/adapters/elevenlabs.py` — `ElevenLabsAgent` (§5.4)
- `python/scenario/voice/adapters/vapi.py` — `VapiAgent` (§5.5)
- `python/scenario/voice/adapters/openai_realtime.py` — `OpenAIRealtimeAgent` (§5.6). Supports `role=AgentRole.USER` for realtime user-sim (§7.2 L1164-1171 — this is a CHOSEN alternative, not rejected).
- `python/scenario/voice/adapters/gemini_live.py` — `GeminiLiveAgent` (§5.6)
- `python/scenario/voice/adapters/websocket.py` — generic `WebSocketAgent` + `WebSocketProtocol` ABC (§5.7)
- `python/scenario/voice/adapters/webrtc.py` — generic `WebRTCAgent` (§5.7)

Files to modify:
- `python/scenario/__init__.py` — re-export all adapter classes

### Phase 3 — Interruptions & Advanced Script Steps (Source §10 L1326-1332)

Files to create:
- `python/scenario/voice/interruption.py` — `InterruptionConfig`, contextual/random_phrase strategies (§4.4 L478-492)

Files to modify:
- `python/scenario/script.py` — add `agent(wait=False)` support, `interrupt()`, `dtmf()`
  - `interrupt(after_words=N)` on adapters without streaming transcripts must raise `UnsupportedCapabilityError` (Resolved Decision #1)
- `python/scenario/scenario_executor.py` — implement async agent turns and interruption scheduling in `proceed()`

### Phase 4 — Audio Effects & Simulation (Source §10 L1334-1339)

Files to create:
- `python/scenario/voice/effects/__init__.py` — re-exports
- `python/scenario/voice/effects/noise.py` — `background_noise`, `multiple_voices`, `static`
- `python/scenario/voice/effects/quality.py` — `phone_quality`, `low_quality`, `packet_loss`, `breaking_up`, `robotic`, `echo`
- `python/scenario/voice/effects/prosody.py` — `speaking_fast`, `speaking_slow`, `low_volume`, `high_volume`
- `python/scenario/voice/effects/custom.py` — `custom(fn)` wrapper
- `python/scenario/voice/assets/noise/{cafe,street,office,airport,babble}.wav` — bundled samples (<1MB total per §4.5 L546)

Files to modify:
- `python/scenario/user_simulator_agent.py` — apply effects AFTER TTS cache hit (Resolved Decision #3)
- `python/scenario/script.py` — per-step `audio_effects` override (§4.2 L291-294)

### Phase 5 — Observability & Output (Source §10 L1341-1346)

Files to modify:
- `python/scenario/scenario_executor.py` — build `VoiceEvent` timeline, `LatencyMetrics`, invoke `on_audio_chunk` / `on_voice_event` hooks
- `python/scenario/config.py` — global `audio_playback: bool` config
- `python/scenario/voice/playback.py` — live playback via `ffplay` subprocess using the bundled ffmpeg binary (Locked Decision #8). Graceful no-op on headless systems.
- `python/scenario/_events/` — emit voice events so LangWatch Simulations Visualizer can render them (audio player in UI is LangWatch-side, not in this PR)

## Dependency Additions (`python/pyproject.toml`)

Hard dependencies (no `extras`, per Resolved Decision #4):
- `imageio-ffmpeg>=0.5.0` — bundles ffmpeg binary, exposed via `imageio_ffmpeg.get_ffmpeg_exe()`. Used for format conversion, MP3 export, `speaking_fast/slow`, effect pipeline.
- `numpy>=1.26` — audio sample math (mixing, amplitude, time-stretch prep, packet-loss zeroing).
- `soundfile>=0.12` — WAV/FLAC/OGG I/O. Handles `scenario.audio(path)` decode and `result.audio.save()` encode.
- `webrtcvad-wheels>=2.0` — SDK-side VAD fallback for adapters without native VAD (Locked Decision #6). Note: use the maintained fork, not the original `py-webrtcvad` which lacks Python 3.12/3.13 wheels.
- `websockets>=12` — WebSocket transport (Pipecat-WS, ElevenLabs, Vapi, generic `WebSocketAgent`).
- `aiortc>=1.7` — WebRTC transport (Pipecat-WebRTC, generic `WebRTCAgent`).
- `twilio>=9.0` — REST API for outbound calls (Media Streams goes over websockets, not Twilio's Python client).
- `livekit>=0.17` + `livekit-api>=0.7` — LiveKit room participation.
- `elevenlabs>=1.0` — ElevenLabs TTS (used by voice user-simulator and `ElevenLabsAgent`).
- `google-cloud-texttospeech>=2.16` — Google TTS provider (optional, gate by runtime check if the user picks `"google/..."`).
- `cartesia>=1.0` — Cartesia TTS provider (same gating pattern).

STT default uses `openai>=1.88` (already a hard dep) for `gpt-4o-transcribe`. Users can plug alternative providers via `scenario.configure(stt=...)` without the SDK adding provider-specific deps.

### Bundled noise assets
Per Locked Decision #7, ~1MB of royalty-free CC0 WAV samples ship inside the package at `python/scenario/voice/assets/noise/` (cafe, street, office, airport, babble). License file included alongside.

## Test Strategy

### Unit tests (mocked transport, no network, no real TTS)
- `python/tests/voice/test_audio_chunk.py` — PCM16 normalization at adapter boundaries
- `python/tests/voice/test_tts_cache.py` — cache key is `(text, voice)`; effects applied post-cache
- `python/tests/voice/test_user_simulator_voice.py` — text→TTS pipeline with mocked TTS client
- `python/tests/voice/test_judge_auto_detect.py` — multimodal vs transcript-only fallback
- `python/tests/voice/test_script_steps.py` — `sleep`, `silence`, `audio`, `interrupt`, `dtmf`
- `python/tests/voice/test_interrupt_capability_error.py` — `after_words` on non-streaming adapter raises
- `python/tests/voice/test_effects_*.py` — each effect transforms bytes as expected
- `python/tests/voice/test_result_recording.py` — `save()`, `segments`, `timeline`, `latency`

Mocking approach:
- **TTS:** Monkeypatch the TTS router to return a short canned WAV fixture keyed by text. Avoids real API calls in CI.
- **STT:** Same — canned transcript per fixture.
- **Transports:** For each adapter, use a fake server (`aiohttp` for WS, `aiortc` loopback for WebRTC, `respx` for HTTP signalling) that echoes a fixture audio file.
- **ffmpeg:** Real binary via `imageio-ffmpeg` — fast enough for CI.
- **Audio fixtures:** Tiny (<50KB) WAV fixtures in `python/tests/fixtures/voice/` — real audio, not synthesized, so the audio path is exercised end-to-end.

### Integration tests (live TTS + live local transport, gated)
- `python/tests/voice/integration/test_example_6_1_greeting.py` … `test_example_6_8_silence.py` — one file per §6 example, gated by `API key presence (matches `python/tests/test_red_team_agent.py:1210-1216` pattern)` env var.
- Pain-pattern ACs (§8) also live-gated.

### CI considerations
- All `@unit` scenarios run in CI with mocked TTS/STT and loopback transports.
- `@integration` scenarios check `os.environ.get("OPENAI_API_KEY")` (etc.) and skip if absent. Matches the existing convention at `python/tests/test_red_team_agent.py:1210-1216`.
- ffmpeg binary is installed via `imageio-ffmpeg` wheel — no apt install needed in CI image.
- WebRTC tests (`aiortc`) need libsrtp. Most Linux runners have it; document in CI setup if not.

## Locked Design Decisions (extend the 4 from the issue description)

5. **STT provider** — pluggable `STTProvider` interface, not a hardcoded provider. Default implementation uses OpenAI (`gpt-4o-transcribe`, reuses existing `openai` dep). Users swap via `scenario.configure(stt=...)`. Provider-agnostic by design — we don't control which provider users prefer.
6. **VAD fallback for adapters without native VAD** — SDK-side fallback via `webrtcvad-wheels` (the maintained fork of py-webrtcvad). Emits a one-shot `UserWarning` when fallback activates: `"Adapter {name} has no native VAD — using SDK-side webrtcvad. Accuracy may differ from native."`. Surfaced in the adapter capability matrix docs.
7. **Noise sample bundling** — ~1MB of royalty-free WAV samples ships with the core SDK (cafe, street, office, airport, babble). Effects work out of the box. If bloat becomes a complaint, split to a separate `scenario-voice-assets` package in a follow-up.
8. **Local audio playback** — `ffplay` via subprocess (uses the bundled ffmpeg binary). No `sounddevice`/PortAudio dep. Degrades gracefully on headless systems (no-op + debug log).

## Adapter Capability Matrix (requirement)

Each adapter publishes `adapter.capabilities: AdapterCapabilities` — a documented contract listing:
- `streaming_transcripts: bool`
- `native_vad: bool`
- `dtmf: bool`
- `input_formats: list[str]` (e.g., ["pcm16", "mulaw", "opus"])
- `output_formats: list[str]`

Capability-gated script steps (`interrupt(after_words=N)`, `dtmf()`) check the matrix and raise `UnsupportedCapabilityError` with a clear message on unsupported adapters. The matrix is also rendered into the docs so users can pick an adapter knowing what works.

## Adaptability note (from JS survey)

Fix the `forceUserRole` class of issues seen in `javascript/examples/vitest/tests/helpers/openai-voice-agent.ts` at the type level — audio must work cleanly in any message role (user, assistant, tool). Do not replicate the workaround in Python. The `ModelMessage` content union / audio field must accept audio in any role without special flags.

## Remaining Open Implementation Questions (implementer resolves during PR)

1. **Multimodal audio encoding to LLM judge** — §4.3 L325 says "audio is passed to multimodal models that support it" without specifying encoding. OpenAI's chat API supports `input_audio` with base64 `data` + `format`. Gemini supports inline base64. Implementer picks per-provider encoding in the judge.
2. **Audio cache storage location** — locked decision #2 (cache key `(text, voice)`) doesn't lock storage. Options: reuse existing `scenario.cache` joblib dir, or separate audio cache dir with size-based eviction. Implementer picks.
3. **`InterruptionConfig(strategy="contextual")` LLM prompt** — §4.4 L490. Proposal does not provide the prompt. Implementer authors a short prompt that produces short interruption phrases from running conversation context.
4. **`LatencyMetrics.time_to_first_byte` semantics** — §4.6 L623. Unclear if this is first transport byte or first audio byte after silence. Implementer picks and documents.
5. **`OpenAIRealtimeAgent(role=AgentRole.USER)` behavior vs scripted `user("text")` steps** — §7.2 L1164-1171. When realtime-user-sim is active, `user("text")` should probably route through the realtime session's text input rather than spawn TTS. Note: OpenAI Realtime API cannot populate assistant audio messages retroactively — this breaks simple replay semantics. Implementer confirms and documents.
6. **WebRTC signaling client** — §5.1 L684-700. Recommendation: `aiortc` direct (not `pipecat-ai`, which is a multi-hundred-MB transitive dep). Implementer confirms.
7. **OpenAI `gpt-4o-transcribe` 25-minute audio limit** — rarely hit in practice (transcription happens per-turn, not per-conversation), but worth a guard: if a single turn exceeds 25 min, chunk it. Implementer adds the guard.

## Traceability Table

| AC (Scenario name) | Proposal section | Source lines |
|---|---|---|
| PipecatAgent WebSocket connect | §4.1, §5.1 | L137-142, L664-682 |
| PipecatAgent WebRTC connect | §4.1, §5.1 | L144-148, L684-700 |
| LiveKitAgent room join | §4.1, §5.2 | L151-156, L713-731 |
| TwilioAgent outbound call | §4.1, §5.3 | L161-166, L733-758 |
| ElevenLabsAgent connect | §4.1, §5.4 | L171-174, L760-776 |
| VapiAgent connect | §4.1, §5.5 | L177-180, L778-793 |
| OpenAIRealtimeAgent as AUT | §4.1, §5.6 | L185-190, L800-813 |
| OpenAIRealtimeAgent as USER | §7.2 | L1164-1171 |
| GeminiLiveAgent connect | §4.1, §5.6 | L193-197, L815-826 |
| Generic WebSocketAgent + protocol | §4.1, §5.7 | L202-205, L856-868 |
| WebRTCAgent | §4.1 | L208-210 |
| connect/disconnect lifecycle | §4.1 | L213-230 |
| AudioChunk normalization | Resolved #2 | — |
| User sim text-only unchanged | §4.2 | L249-250 |
| User sim voice=... | §4.2 | L252-256 |
| TTS provider routing | §4.2 | L271-280 |
| TTS cache key | §7.2, Resolved #3 | L1158 |
| Per-step voice_style | §4.2 | L290-294 |
| Per-step audio_effects | §4.2 | L293 |
| Persona + global effects | §4.2 | L259-268 |
| Judge auto-detect | §4.3 | L309-318 |
| Always transcripts | §4.3 | L324 |
| Audio to multimodal | §4.3 | L325, L362 |
| Transcript fallback | §4.3 | L362-363 |
| Timeline included | §4.3 | L326-345 |
| OTel traces | §4.3 | L347, L358 |
| include_audio=False override | §4.3 | L353-358 |
| agent(wait=False) | §4.4 | L369-382 |
| sleep | §4.4 | L394-406 |
| silence | §4.4 | L408-417 |
| dtmf | §4.4, §5.3 | L419-432 |
| audio file | §4.4 | L434-448 |
| audio bytes | §4.4 | L448 |
| audio formats | §4.4 | L448 |
| interrupt(after=T) | §4.4 | L450-467 |
| interrupt(after_words) OK | §4.4 | L469-476 |
| interrupt(after_words) error | Resolved #1 | — |
| InterruptionConfig contextual | §4.4 | L478-490 |
| InterruptionConfig random_phrase | §4.4 | L491 |
| Global effects | §4.5 | L499-510 |
| Effects enumeration | §4.5 | L517-534 |
| Custom effect | §4.5 | L534 |
| Accents via voice | §4.5 | L536-544 |
| Dynamic effects | §4.5 | L548-557 |
| Existing result fields | §4.6 | L567-574 |
| save WAV | §4.6 | L583-598 |
| save MP3 | §4.6 | L586 |
| segments | §4.6 | L588-595 |
| timeline | §4.6 | L600-615 |
| latency | §4.6 | L617-625 |
| Live playback | §4.7 | L631-643 |
| on_audio_chunk hook | §4.7 | L647-653 |
| on_voice_event hook | §4.7 | L647-653 |
| Example 6.1 | §6.1 | L874-899 |
| Example 6.2 | §6.2 | L901-929 |
| Example 6.3 | §6.3 | L931-967 |
| Example 6.4 | §6.4 | L969-996 |
| Example 6.5 (callable step) | §6.5 | L998-1028 |
| Example 6.6 | §6.6 | L1030-1055 |
| Example 6.7 | §6.7 | L1057-1085 |
| Example 6.8 | §6.8 | L1087-1113 |
| Pain: long hold | §8 | L1231-1241 |
| Pain: accent loop | §8 | L1243-1257 |
| Pain: multi-intent | §8 | L1259-1261 |
| Pain: background handoff | §8 | L1263-1265 |
| Pain: emotional escalation | §8 | L1267-1269 |
| Same entrypoint | §1 | L9 |
| Text scenarios unaffected | §3 | L116-124 |
| Custom adapter | §7.3, §5.7 | L1186, L830-854 |
| Hard deps | Resolved #4 | — |
