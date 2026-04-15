# Issue #350 — Voice Agents: Open Implementation Questions Resolved

Resolutions for the 10 questions in `docs/proposals/issue-350-delivery-plan.md` § Risks and Open Implementation Questions. Each recommendation is a default that the implementer may overrule with justification at the listed decision gate.

Source references use the canonical lines in `docs/proposals/issue-350-voice-agents-source.md`.

---

### Q1: STT provider for transcripts

**Proposal says:** §4.3 L324 requires "automatic STT of all audio messages (always included)" but does not name a provider. The delivery plan placeholder is `openai>=1.88` (already a transitive dep via LiteLLM).

**Recommendation:** Default to `openai/gpt-4o-transcribe` via the existing LiteLLM path, with `scenario.configure(stt="provider/model")` override. Enforce the 25-minute per-request limit: if a single turn's audio exceeds 25 minutes, chunk it before sending.

**Why:** Reuses an already-pinned dep, avoids a new heavyweight vendor, and matches pricing of Whisper ($0.006/min) with better accuracy on short conversational clips. Tests are short (sub-5-min typical), so the 25-min limit is a non-issue. Caching of `(audio_bytes_hash, model)` keeps cost near zero on replay.

**Flags / risks:**
- `gpt-4o-transcribe` has had reported regressions vs Whisper on noisy audio — consider `whisper-1` as a fallback for effect-heavy scenarios.
- Requires `OPENAI_API_KEY` in CI for integration tests; unit tests must monkeypatch.
- 25-min ceiling must be enforced or chunked.

**Alternatives considered:**
- **Local Whisper (`faster-whisper`)** — no API key, free, but ~200MB model download and CPU-heavy in CI.
- **Deepgram Nova-3** — fastest and most accurate, but adds a vendor lock-in and a new SDK dep.

**Decision gate:** Implementer during Phase 1. Safe default; user can override via `scenario.configure(stt=...)`.

---

### Q2: Multimodal audio encoding to LLM judge

**Proposal says:** §4.3 L325, L362 says "audio is passed to multimodal models that support it" with no encoding detail. §7.5 L1204-1210 locks in multimodal-LLM-with-timeline as the approach.

**Recommendation:** Encode per-provider via a small `_encode_audio_for_judge(model, audio)` dispatcher: OpenAI GPT-4o gets `{"type": "input_audio", "input_audio": {"data": <b64>, "format": "wav"}}`; Gemini gets `inline_data` parts with `mime_type: audio/wav`; any other model auto-falls back to transcript-only (§4.3 L362-363).

**Why:** The two multimodal judges named in §4.3 L325 (GPT-4o, Gemini) have stable but incompatible wire formats. A thin dispatcher is the minimal abstraction; LiteLLM's `input_audio` handling is still inconsistent across providers as of 2026. Capability detection via `litellm.supports_audio_input(model)` with a hand-maintained fallback list for new releases.

**Flags / risks:**
- Audio >20MB may exceed context limits — chunk or downsample to 16kHz mono before encoding.
- Gemini Files API is faster for >5MB but async-upload; start with inline and optimize later.

**Alternatives considered:**
- **LiteLLM uniform API only** — simpler, but coverage gaps force per-provider code anyway.
- **Transcript-only judge** — rejected by §7.5 L1221-1223.

**Decision gate:** Implementer during Phase 1; verify encoding against current OpenAI/Gemini docs at implementation time.

---

### Q3: Timeline event source when adapter has no VAD

**Proposal says:** §4.3 L328-345 specifies the timeline format (user_start_speaking, user_stop_speaking, etc.) but assumes events are available. Twilio Media Streams, generic `WebSocketAgent`, and `audio()` injection have no native VAD.

**Recommendation:** Add `webrtcvad-wheels>=2.0.11` as a hard dep; implement `scenario/voice/vad.py` with a 30ms frame, aggressiveness=2 VAD that runs over PCM16@16kHz for any adapter that does not emit native VAD events. Adapters that do emit VAD (Pipecat, LiveKit, OpenAI Realtime) skip the fallback.

**Why:** WebRTC VAD is the industry default, fast (CPU-negligible), battle-tested, and maintained via `webrtcvad-wheels` (Py 3.12/3.13 wheels on PyPI). Silero VAD is more accurate but requires torch, which blows up install size for a feature that only produces timeline markers. Accuracy is acceptable for test-observation purposes — we're logging events, not gating behavior.

**Flags / risks:**
- WebRTC VAD only accepts 8/16/32/48 kHz — must resample from transport-native rate (e.g., 24kHz).
- Original `wiseman/py-webrtcvad` is unmaintained; use the `-wheels` fork.

**Alternatives considered:**
- **Silero VAD (torch)** — higher accuracy, but +500MB torch dep is unacceptable for a hard dep.
- **Energy-threshold VAD (numpy)** — no new dep, but brittle with `background_noise` effects applied.

**Decision gate:** Implementer during Phase 1 (blocks Phase 5 timeline construction).

---

### Q4: Cache location and TTL for TTS audio

**Proposal says:** The **TTS cache key** decision (Source L1158) locks the cache key to `(text, voice)`. Storage is unspecified. Existing `python/scenario/cache.py` uses `joblib.Memory` at `~/.scenario/cache` (env: `SCENARIO_CACHE_DIR`).

**Recommendation:** Reuse the existing joblib `Memory` instance with a dedicated subdirectory `~/.scenario/cache/tts/` keyed on `sha256(text + voice + provider)`. No TTL; add an LRU size cap of 500MB via a small `_evict_if_over(limit)` helper invoked on write. Separate subdir so audio never collides with LLM-response cache entries.

**Why:** Consistent with existing SDK behavior — one cache dir, one env override. A size cap matters more than TTL since TTS output is effectively immutable. 500MB holds ~5 hours of PCM16@24kHz audio, enough for hundreds of test scenarios. Users already control invalidation via `cache_key`.

**Flags / risks:**
- joblib stores pickles; prefer raw WAV files under the subdir + JSON manifest for easier inspection and smaller footprint.
- Concurrent test processes need file-locking on eviction (use `filelock`).

**Alternatives considered:**
- **No cache** — violates the **TTS cache key** decision's determinism goal.
- **Time-based TTL** — irrelevant for deterministic inputs.

**Decision gate:** Implementer during Phase 1.

---

### Q5: Bundled noise sample provenance

**Proposal says:** §4.5 L546 requires ~5 WAV samples under 1MB total, bundled with the package. Source is silent on licensing.

**Recommendation:** Source all five from Freesound's CC0 tag (`freesound.org/browse/tags/cc0/`). Four for `background_noise` presets (cafe, street, office, airport per §4.5 L521) and one for the `multiple_voices` effect (babble per §4.5 L533 — NOT a `background_noise` preset). Trim to 10s mono 16kHz WAV (~320KB each, ~1.6MB total; may need to drop to 8s or 8kHz for the <1MB cap). Ship `python/scenario/voice/assets/noise/LICENSES.md` with per-file attribution, original URLs, and CC0 text.

**Why:** CC0 is the only license that allows unambiguous redistribution inside a software package with no downstream obligations. Freesound has a dedicated CC0 browse filter and high-quality field recordings. Pixabay is a viable backup.

**Flags / risks:**
- 1MB cap is tight — may need 8kHz mono to fit all 5. Fine for `background_noise` which is mixed at low volume anyway.
- Verify each file's CC0 status on Freesound before download — some are CC-BY mislabeled.

**Alternatives considered:**
- **Synthesize noise (numpy)** — zero license risk, but "babble" and "airport" can't be synthesized convincingly.
- **Optional download on first use** — avoids wheel bloat but breaks offline-first principle.

**Decision gate:** Implementer during Phase 4; flag chosen files in the PR for license review.

---

### Q6: `InterruptionConfig(strategy="contextual")` prompt

**Proposal says:** §4.4 L488-490 names the strategy but does not provide a prompt. §4.4 L478-492 shows only the API shape.

**Recommendation:** Use a ~120-token system prompt that takes the last 2 turns of conversation and asks for exactly one short (3-8 word) interruption phrase. Model: cheap/fast (`openai/gpt-4o-mini`). Prompt body:

> "You are simulating a user interrupting a voice agent. Given the agent's in-progress response, produce ONE short interjection (3-8 words) that naturally interrupts. Express impatience, correction, or disagreement consistent with the conversation. Return only the phrase, no quotes, no punctuation beyond a question mark or exclamation. Examples: 'Wait, that's wrong', 'No, I said Chicago', 'Hold on, hold on'."

Wire the prompt via the same LLM client the user-simulator uses. Include the persona string if one is configured so interruptions stay in character.

**Why:** Short, few-shot, cheap. Matches the user-simulator's existing model-selection pattern and caches per `(context_hash, persona)`.

**Flags / risks:**
- LLM may emit quoted or multi-sentence output — strip and truncate.
- Requires persona-awareness integration; silent otherwise on persona-vs-interrupt tone mismatch.

**Alternatives considered:**
- **Hand-crafted phrase list** — covered by `strategy="random_phrase"` (§4.4 L491); doesn't replace contextual.
- **Reuse user-simulator LLM with special instruction** — tighter coupling, harder to tune independently.

**Decision gate:** Implementer during Phase 3.

---

### Q7: `LatencyMetrics.time_to_first_byte` semantics

**Proposal says:** §4.6 L623 lists the field without defining it. §4.3 L344 shows "avg_response" and "p95_response" as `user_stop → agent_start`.

**Recommendation:** Define `time_to_first_byte` as the duration from the moment the SDK finishes sending the user's final audio byte to the moment it receives the first non-silent audio byte from the agent (post-VAD-gated, not counting pure-silence padding). Document in the docstring: `"Time from user_stop_speaking to first audible agent byte. This is the user-perceived responsiveness metric — excludes silent ramp-up from the agent."` Rename internally to `time_to_first_audio_byte` if it helps clarity.

**Why:** "First transport byte" is measurable but meaningless (some providers send empty frames immediately). "First audible byte" aligns with what a human caller experiences — that's the whole point of voice latency testing. The VAD fallback from Q3 is already available to gate silence.

**Flags / risks:**
- Requires VAD even for TTS-style adapters that frame-align.
- Distinguish from `avg_response_time`: TTFB is per-call, the response_times are aggregate.

**Alternatives considered:**
- **First transport byte** — noisier, less meaningful, but trivially cheap.
- **First token (text)** — wrong layer; this is a voice-latency metric.

**Decision gate:** Implementer during Phase 5; document chosen semantics in the `LatencyMetrics` docstring.

---

### Q8: Playback backend — RESOLVED

**Proposal says:** §4.7 L631-643 specifies `audio_playback=True` and `on_audio_chunk` hooks. Does not specify a backend.

**Locked decision:** `ffmpeg` subprocess with a platform audio-output driver (using the bundled binary from `imageio-ffmpeg`). No `sounddevice`/PortAudio dep. Not `ffplay` — `imageio-ffmpeg` bundles `ffmpeg` but NOT `ffplay`. Graceful no-op on headless systems (missing device → debug log, scenario continues).

**Why:** Reuses the ffmpeg binary we already ship. Zero new native deps. Playback is a dev-loop convenience, not a production feature — latency is not load-bearing. Users who want custom playback wire `on_audio_chunk` themselves.

**Decision gate:** Locked by user. Not open for re-deliberation.

---

### Q9: `OpenAIRealtimeAgent(role=AgentRole.USER)` interaction with scripted `user("text")`

**Proposal says:** §7.2 L1164-1171 shows realtime-as-user-sim as a supported alternative. Delivery plan Phase 2 confirms `role=AgentRole.USER` is a chosen alternative, not rejected. Source is silent on how scripted `user("text")` steps behave when the user-sim is a realtime agent.

**Recommendation:** When `role=AgentRole.USER` is active, scripted `user("text")` MUST route the text through the realtime session's `conversation.item.create` event with `input_text` content (followed by `response.create` to trigger audio generation) — NOT through a separate TTS pipeline. Document that `voice=`, `audio_effects=`, and persona on the realtime user-sim are passed to the realtime session's `voice` and `instructions` params; TTS-layer `audio_effects` are silently ignored with a warning (post-generation effects on realtime output are a separate non-goal).

**Why:** `conversation.item.create` with `input_text` is explicitly supported by the OpenAI Realtime API and is the canonical mechanism for injecting user text mid-stream. Running parallel TTS would desync the conversation state on the realtime side. Warning on ignored effects avoids silent misconfiguration.

**Flags / risks:**
- Realtime API currently can't populate assistant audio messages, so replay/cache semantics differ from TTS-based sim — document this in the adapter.
- Per-step `voice_style` (§4.2 L290-294) doesn't map cleanly; either forward to `instructions` per turn or raise `UnsupportedCapabilityError`.

**Alternatives considered:**
- **Spawn parallel TTS for scripted `user()` steps** — desyncs realtime session state, produces audio-layer race conditions.
- **Raise error on any scripted `user("text")` with realtime user-sim** — too restrictive; Example 6.1 would break.

**Decision gate:** Implementer during Phase 2 when building `OpenAIRealtimeAgent`. Document the behavior in the adapter's docstring.

---

### Q10: WebRTC signaling client for Pipecat SmallWebRTC

**Proposal says:** §5.1 L684-700 shows `PipecatAgent(signaling_url=..., transport="webrtc")`. Source is silent on the signaling implementation.

**Recommendation:** Implement the SDP exchange directly with `aiortc` (already a hard dep via delivery plan). Do NOT take a `pipecat-ai` dep. The Pipecat SmallWebRTC signaling protocol is a simple HTTP POST of an SDP offer to `/api/offer` returning an SDP answer — ~50 LOC with `aiortc.RTCPeerConnection` + `aiohttp`.

**Why:** `pipecat-ai` is a multi-hundred-MB dep (includes torch, transformers, bot-runtime scaffolding) that dwarfs the rest of Scenario. The client-side of SmallWebRTC is a well-documented one-shot SDP exchange — adding `pipecat-ai` as a runtime dep for 50 lines of signaling would be an order-of-magnitude overcorrection. `aiortc` already underpins SmallWebRTCTransport itself, so we're using the same primitive it does.

**Flags / risks:**
- If Pipecat's SmallWebRTC signaling protocol evolves, we must track it manually. Mitigation: version-pin compatibility and add a contract test against a local Pipecat bot.
- ICE/STUN config must match Pipecat defaults (`stun:stun.l.google.com:19302`).

**Alternatives considered:**
- **Take `pipecat-ai` as a dep** — huge install footprint, unacceptable for a client library.
- **Require user-provided signaling client** — shifts the burden to users; breaks the "just works" ethos of §1.

**Decision gate:** Implementer during Phase 2 when building `PipecatAgent`.

---

## Summary table

| # | Question | Resolution type | Gate |
|---|---|---|---|
| 1 | STT provider | Technical default | Implementer (Phase 1) |
| 2 | Multimodal audio encoding | Technical default | Implementer (Phase 1) |
| 3 | VAD fallback | Technical default | Implementer (Phase 1) |
| 4 | Cache location | Technical default | Implementer (Phase 1) |
| 5 | Noise sample provenance | Technical default | Implementer (Phase 4) |
| 6 | Contextual-interrupt prompt | Technical default | Implementer (Phase 3) |
| 7 | TTFB semantics | Technical default | Implementer (Phase 5) |
| 8 | Playback backend | **User preference** | User before ralph-loop |
| 9 | Realtime user-sim + scripted text | Technical default | Implementer (Phase 2) |
| 10 | WebRTC signaling client | Technical default | Implementer (Phase 2) |

Only Q8 is a genuine user-preference call. Everything else has a clear technical default that the implementer can adopt unless corrected.
