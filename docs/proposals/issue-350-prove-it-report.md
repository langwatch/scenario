# Issue #350 / PR #355 — /prove-it Evidence Table

**Date:** 2026-04-20
**Branch:** `issue350/voice-agents-implement-per-research`
**Feature file:** `specs/voice-agents.feature` (102 scenarios: 69 `@unit`, 8 `@integration`, 25 `@e2e`).
Header was 83/64/19; current header reflects two later additions: +16 for locked-decision composable/branded agents and @e2e demo parity (lifted to 99 total), and +3 for AC-14 demo recordings (1 @unit + 2 @integration). The §-by-§ evidence rows below were authored against the 83-scenario baseline and have not been regenerated row-by-row for the later additions — this is the drift called out in the contract test.

## Test-run baseline

```
cd python && CI=true uv run pytest tests/voice --tb=no -q
  → 217 passed, 9 skipped, 8 warnings in ~5s
```

**Pytest-BDD is NOT wired.** The 83 Gherkin scenarios do not execute as tests. They are mapped below by inspection to pytest test functions. This is a known gap (PR body "Deferred #12").

The 9 skips all live in `test_agent_wait_false.py`, `test_executor_lifecycle.py`, and `test_hooks.py` — skipped under `CI=true` because `scenario.run` hangs in GitHub Actions (documented in-repo, passes locally).

## Classification legend

- **PASS** — named pytest test exists and is in the passing set.
- **DEFERRED** — requires a real transport on a stub adapter (7 of 10 adapters raise `PendingTransportError`), or listed in PR body "Deferred to follow-up."
- **UNVERIFIED** — implementation exists but no test exercises the scenario.
- **MISSING** — neither test nor implementation found.
- **INTEGRATION-ONLY** — implemented, covered only by `@integration` tests gated by live API keys.

## Stub adapter reference

| Adapter | Transport status |
|---|---|
| Twilio | REAL (Media Streams) |
| Pipecat WebSocket | REAL |
| Pipecat WebRTC | STUB — `PendingTransportError` at `pipecat.py:105` |
| OpenAIRealtime | STUB — `openai_realtime.py:60,66` |
| GeminiLive | STUB — `gemini_live.py:43,49` |
| ElevenLabs | STUB — `elevenlabs.py:45,51` |
| Vapi | STUB — `vapi.py:42,48` |
| LiveKit | STUB — `livekit.py:43,49` |
| WebRTC | STUB — `webrtc.py:44,50` |
| Generic WebSocket | REAL |

---

## Evidence table (83 scenarios)

### §4.1 Voice Agent Adapters (13 scenarios)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 1 | PipecatAgentAdapter WebSocket + mulaw/8000 | PASS | `test_pipecat_adapter.py::test_connect_sends_connected_then_start_with_fabricated_sids`, `::test_send_audio_emits_media_frames_20ms_each`, `::test_websocket_transport_requires_url`; `pipecat.py:59,69,96` |
| 2 | PipecatAgentAdapter WebRTC | DEFERRED | `test_pipecat_adapter.py::test_webrtc_transport_raises_pending` asserts `PendingTransportError` at `pipecat.py:105`. Real WebRTC negotiation not implemented. |
| 3 | LiveKitAgentAdapter joins a room | DEFERRED | `test_adapter_stubs.py` covers the raise. Real `livekit.connect` / room-join code absent — `livekit.py:43-52` is two raise-sites. |
| 4 | TwilioAgentAdapter places an outbound call (@integration) | INTEGRATION-ONLY | `test_twilio_adapter.py::test_place_call_transitions_to_call_mode`, `::test_place_call_passes_twiml_url_to_rest` exercise the REST-call code path with mocks. Actual PSTN call is integration-only (no live run). |
| 5 | ElevenLabs WebSocket to convai endpoint | DEFERRED | `test_adapters.py::test_elevenlabs_url_includes_agent_id` verifies URL construction. Socket open/PCM16 send deferred — `elevenlabs.py:45,51`. |
| 6 | Vapi call creation + websocketCallUrl | DEFERRED | `test_adapters.py::test_vapi_capabilities` asserts metadata. REST-create + socket connect deferred — `vapi.py:42,48`. |
| 7 | OpenAIRealtimeAgentAdapter as agent | DEFERRED | `test_adapters.py::test_openai_realtime_defaults_to_agent_role`, `::test_openai_realtime_capabilities_are_streaming`. Session establishment raises at `openai_realtime.py:60`. |
| 8 | OpenAIRealtimeAgentAdapter role=USER | PASS | `test_adapters.py::test_openai_realtime_user_role_is_a_chosen_alternative` + `test_openai_realtime_user_routing.py::test_scripted_user_text_routes_to_realtime_send_text`. TTS-bypass routing is implemented even though transport is stub. |
| 9 | GeminiLive native-audio endpoint | DEFERRED | `test_adapters.py::test_gemini_live_defaults` covers ctor. Session establishment raises at `gemini_live.py:43`. |
| 10 | WebSocketAgentAdapter w/ user protocol | PASS | `test_adapters.py::test_websocket_agent_stores_protocol`, `::test_websocket_protocol_is_abstract`; real impl at `websocket.py:53-79`. |
| 11 | WebRTCAgentAdapter via signaling_url | DEFERRED | `test_adapters.py::test_webrtc_agent_stores_signaling_url` covers ctor. Peer-connection negotiation raises at `webrtc.py:44,50`. |
| 12 | Executor calls connect() before + disconnect() after every scenario | PASS | `test_executor_lifecycle.py::test_connect_called_once_before_script_and_disconnect_after_success`, `::test_disconnect_still_called_when_script_step_raises` (skipped under CI, pass locally — same file). |
| 13 | AudioChunk internal format PCM16/24kHz/mono | PASS | `test_audio_chunk.py::test_audio_chunk_defaults_to_pcm16_24khz_mono` + 3 companions. |

### §4.2 Voice-Enabled User Simulator (7 scenarios)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 14 | UserSimulatorAgent without voice unchanged | PASS | `test_user_sim_voice.py::test_user_sim_without_voice_unchanged` + `test_executor_lifecycle.py::test_text_only_scenario_has_no_voice_fields`. |
| 15 | UserSimulatorAgent with voice produces audio | PASS | `test_user_sim_voice.py::test_user_sim_accepts_voice_parameter`; TTS attaches audio via `tts.py::synthesize` (`test_tts.py::test_synthesize_attaches_transcript_for_judge`). |
| 16 | TTS voice string "provider/voice_name" | PASS | `test_tts.py::test_provider_prefix_routes_to_registered_backend`, `::test_unknown_provider_prefix_raises_with_list_of_known`, `::test_voice_without_slash_raises`. |
| 17 | TTS cache key is (text, voice); effects post-cache | PASS | `test_tts.py::test_same_text_and_voice_synthesize_once`, `::test_cache_keys_on_text_and_voice_not_just_one`, `::test_text_is_hashed_before_joblib_sees_it`. |
| 18 | Per-step voice_style override | PASS | `test_per_step_overrides.py::test_user_sim_one_shot_override_is_scoped_to_context`, `::test_scenario_user_accepts_voice_style_and_audio_effects`. NB: PR body reviewer finding #2 disclosed that `voice_style` currently emits a `UserWarning` rather than altering audio — tests verify scoping, not voice-style rendering. |
| 19 | Per-step audio_effects override | PASS | `test_per_step_overrides.py::test_user_sim_one_shot_override_nesting_restores_outer_state` + `::test_scenario_user_accepts_voice_style_and_audio_effects`. |
| 20 | Persona + audio_effects compose | PASS | `test_user_sim_voice.py::test_user_sim_accepts_persona`, `::test_user_sim_accepts_audio_effects_list`. |

### §4.3 Voice-Enabled Judge (7 scenarios)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 21 | Judge auto-detects audio without config | PASS | `test_judge_voice.py::test_include_audio_auto_enabled_for_multimodal_model`, `::test_include_audio_false_when_no_audio_in_conversation`. |
| 22 | Judge always includes transcripts | UNVERIFIED | `stt.py::transcribe` exists and `test_stt.py::test_transcribe_uses_existing_transcript_when_present` exercises dedup, but no test asserts the judge's AgentInput has transcripts attached for every audio turn. Grep of `judge_agent.py` shows `include_audio` logic but no `always transcripts` pathway explicitly asserted. |
| 23 | Judge passes audio to multimodal models | PASS | `test_judge_voice.py::test_include_audio_auto_enabled_for_multimodal_model`, `::test_gemini_is_detected_as_audio_capable`. |
| 24 | Judge falls back to transcript-only for non-multimodal | PASS | `test_judge_voice.py::test_include_audio_auto_disabled_for_text_only_model`. |
| 25 | Judge receives structured timeline | PASS | `test_judge_voice.py::test_include_timeline_defaults_true_for_voice_conversations`, `::test_explicit_include_timeline_respected`. |
| 26 | Judge receives OTel traces when configured | PASS | `test_judge_voice.py::test_include_traces_defaults_to_otel_configured`, `::test_explicit_include_traces_respected`. |
| 27 | include_audio=False forces text-only | PASS | `test_judge_voice.py::test_explicit_include_audio_false_forces_text_only_even_with_multimodal_model`. |

### §4.4 Script Extensions (11 scenarios)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 28 | agent(wait=False) returns immediately | PASS | `test_agent_wait_false.py::test_agent_wait_false_returns_before_turn_finishes` (skipped under CI, passes locally). |
| 29 | scenario.sleep(seconds) pauses without touching transport | PASS | `test_script_steps.py::test_sleep_does_not_send_audio_and_pauses_real_time`. |
| 30 | scenario.silence(duration) sends PCM16 zero-audio | PASS | `test_script_steps.py::test_silence_sends_pcm16_zero_audio_of_requested_duration`. |
| 31 | scenario.dtmf(tones) emits DTMF (@integration) | INTEGRATION-ONLY | `test_script_steps.py::test_dtmf_on_telephony_adapter_delegates_to_send_dtmf` asserts the delegation path with a fake adapter. Actual DTMF on a Twilio line is integration-only. |
| 32 | scenario.audio() injects a WAV file | PASS | `test_script_steps.py::test_audio_bytes_injects_chunk_into_adapter` + `test_audio_step_safety.py::test_audio_rejects_missing_file`, `::test_audio_from_bytes_is_fine`. File path acceptance is implicit via path-validation tests. |
| 33 | scenario.audio() accepts raw bytes | PASS | `test_audio_step_safety.py::test_audio_from_bytes_is_fine` + `test_script_steps.py::test_audio_bytes_injects_chunk_into_adapter`. |
| 34 | scenario.audio() supports WAV, MP3, OGG, FLAC | UNVERIFIED | No test exercises format auto-conversion from different extensions. `test_audio_step_safety.py` only tests path/bytes validation. Code path likely in `script_steps.audio` but no asserted end-to-end decoding of MP3/OGG/FLAC fixtures. |
| 35 | scenario.interrupt(after=T, content="...") composes wait=False + sleep + user | PASS | `test_interruption.py::test_interrupt_after_seconds_triggers_agent_wait_false_then_user`. |
| 36 | scenario.interrupt(after_words=N) uses streaming transcript | PASS | `test_interruption.py::test_interrupt_after_words_works_when_streaming_supported`. |
| 37 | interrupt(after_words=N) raises when no streaming | PASS | `test_interruption.py::test_interrupt_after_words_raises_when_adapter_lacks_streaming`. |
| 38 | proceed(interruptions=InterruptionConfig(...)) contextual (@integration) | INTEGRATION-ONLY | `test_interruption.py::test_interruption_config_defaults`, `::test_interruption_config_sample_delay_within_range`, `::test_interruption_config_should_interrupt_respects_probability` verify config mechanics. No end-to-end proceed-with-30%-injection test; contextual LLM generation not asserted — integration-only. |
| 39 | InterruptionConfig strategy="random_phrase" (@integration) | PASS | `test_interruption.py::test_interruption_config_random_phrase_from_list`. (Gherkin tags this integration, but the phrase-list path is unit-testable and tested.) |

### §4.5 Audio Effects (5 scenarios)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 40 | Global audio_effects apply to every turn | PASS | `test_user_sim_voice.py::test_user_sim_accepts_audio_effects_list` + `test_effects.py::test_effects_compose_via_sequential_application`. |
| 41 | Built-in effects enumeration contract | PASS | `test_effects.py::test_every_effect_from_the_proposal_table_exists`, `::test_effect_callable_returns_bytes`. |
| 42 | Custom effect callable wraps user function | PASS | `test_effects.py::test_custom_wraps_user_function`, `::test_custom_requires_callable`, `::test_custom_requires_callable_returns_bytes`. |
| 43 | Accents handled via TTS voice selection, not post-processing | PASS | `test_agent_wait_false.py::test_no_accent_effect_exists`. |
| 44 | Effects vary during conversation via on_turn hook (@integration) | UNVERIFIED | No test with `on_turn` + `s.set_effects(...)`. Grep for `on_turn` returns no matches in `scenario_executor.py`. Feature likely not implemented. Could be MISSING — lack of symbol suggests no code path. |

### §4.6 Results & Output (6 scenarios)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 45 | ScenarioResult preserves existing fields | PASS | `test_result_extensions.py::test_scenario_result_backward_compatible`. |
| 46 | result.audio.save() writes WAV | PASS | `test_recording.py::test_recording_save_wav_writes_file` + `test_recording_save.py::test_save_infers_format_from_suffix`. |
| 47 | result.audio.save(format="mp3") writes MP3 via ffmpeg | PASS | `test_recording_save.py::test_save_mp3_transcodes_via_ffmpeg`, `::test_save_rejects_unknown_format`. |
| 48 | result.audio.segments per-speaker AudioSegments | PASS | `test_recording.py::test_audio_segment_exposes_required_attributes`, `::test_recording_duration_is_max_end_time`. |
| 49 | result.timeline VoiceEvent list in order | PASS | `test_recording.py::test_voice_event_has_time_and_type` + `test_recording_signals.py::test_voice_adapter_call_records_segments_and_timeline`. Full event-ordering with tool_call/user_interrupt not asserted in a single test — composite verified across suite. |
| 50 | result.latency exposes stats | PASS | `test_recording.py::test_latency_metrics_from_measurements`, `::test_latency_metrics_empty_returns_none`; `recording.py:59-75` defines TTFB/p95/interrupt_response_time. |

### §4.7 Real-time Monitoring (3 scenarios)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 51 | audio_playback=True streams audio (@integration) | PASS | `test_playback.py::test_platform_output_args_matches_host_platform`, `test_playback_degradation.py::test_start_failure_sets_inactive_and_logs_at_debug`. Actual device-playback is integration-only but mechanics tested. |
| 52 | on_audio_chunk hook fires per chunk | PASS | `test_hooks.py::test_on_audio_chunk_fires_for_both_speakers` (skipped under CI, passes locally). |
| 53 | on_voice_event hook fires per event | PASS | `test_hooks.py::test_on_voice_event_fires_for_timeline_events` (skipped under CI, passes locally). |

### §6 End-to-End Examples (8 scenarios, all @integration)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 54 | Ex 6.1 — basic greeting flow | INTEGRATION-ONLY | `python/examples/test_voice_to_voice_conversation.py`, `python/examples/voice_pipecat_scenario.py`. No `tests/voice/test_example_6_1*`. Runs against live providers. |
| 55 | Ex 6.2 — interruption recovery | UNVERIFIED | No test or example matches the interrupt_response_time <1.0 assertion. `test_interruption.py::test_interrupt_after_seconds_triggers_agent_wait_false_then_user` covers mechanics but not the latency gate. |
| 56 | Ex 6.3 — angry customer in noisy cafe | UNVERIFIED | Effects + persona tested individually. No composite scenario file wires effects + persona + empathy judge. |
| 57 | Ex 6.4 — DTMF IVR navigation | UNVERIFIED | `test_script_steps.py::test_dtmf_on_telephony_adapter_delegates_to_send_dtmf` covers primitive. No end-to-end IVR routing test. |
| 58 | Ex 6.5 — tool call as plain Python step | UNVERIFIED | Timeline contains `tool_call` events (`recording.py:39`). No test verifying a plain Python callable receives `ScenarioState` at its script position and can assert on `state.timeline` in a voice scenario. Source flagged "NOT OPTIONAL". |
| 59 | Ex 6.6 — pre-recorded audio injection | UNVERIFIED | `scenario.audio(path)` primitive is tested in unit; no integration example that pairs it with a clarification-asking judge. |
| 60 | Ex 6.7 — random interruptions via interrupt_probability | UNVERIFIED | `test_user_sim_voice.py::test_user_sim_interrupt_probability_validated`/`_accepted_in_range` verify the parameter is accepted. No test runs `proceed(turns=5)` and observes ~40% interrupt rate. |
| 61 | Ex 6.8 — silence handling | UNVERIFIED | `test_script_steps.py::test_silence_sends_pcm16_zero_audio_of_requested_duration` covers primitive. No composite silence+proceed+judge example. |

### §8 Real-World Pain Points (5 scenarios, all @integration)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 62 | Pain — long-hold feedback | UNVERIFIED | Primitives (sleep, judge) all exist. No test composes the pain pattern. |
| 63 | Pain — accent misunderstanding loop escape | UNVERIFIED | Not composed anywhere. |
| 64 | Pain — multi-intent single turn | UNVERIFIED | Not composed anywhere. |
| 65 | Pain — background handoff should not trigger agent | UNVERIFIED | Not composed anywhere. |
| 66 | Pain — emotional escalation detection | UNVERIFIED | Not composed anywhere. |

### Architectural Guarantees (3 scenarios)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 67 | Voice tests use scenario.run() | PASS | `test_executor_lifecycle.py::test_connect_called_once_before_script_and_disconnect_after_success` (and siblings) all invoke `scenario.run`. No `scenario.voice.run` symbol exists (grep). |
| 68 | Text-only scenarios unaffected | PASS | `test_executor_lifecycle.py::test_text_only_scenario_has_no_voice_fields`. |
| 69 | VoiceAgentAdapter base class public for custom impls | PASS | `test_adapter_base.py` exists. `test_adapters.py::test_every_adapter_subclasses_voice_agent_adapter[...]` (8 params) asserts subclass contract. |

### Hard Dependencies (1 scenario)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 70 | Hard deps install with the SDK | PASS | `test_default_stt_and_deps.py::test_every_hard_voice_dep_imports`, `::test_imageio_ffmpeg_binary_resolvable`, `::test_bundled_noise_samples_ship_with_package`. Note Gherkin still lists `soundfile`/`aiortc`/`livekit`/`elevenlabs` in the Background as hard deps; the assertion in the test is limited to the actually-shipped ones — feature file and test are internally consistent. |

### Pluggable STT (4 scenarios)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 71 | Default STT is OpenAI gpt-4o-transcribe | PASS | `test_default_stt_and_deps.py::test_default_stt_provider_is_openai_gpt4o_transcribe`. |
| 72 | Users swap STT via scenario.configure | PASS | `test_stt.py::test_set_stt_provider_is_used_by_transcribe`. |
| 73 | STT interface is minimal and provider-agnostic | PASS | `test_stt.py::test_stt_provider_is_abstract`. |
| 74 | Transcription chunks audio >25 min | PASS | `test_stt_chunking.py::test_transcribe_audio_under_25_min_single_call`, `::test_transcribe_audio_over_25_min_chunks_and_concatenates`. |

### Adapter Capability Matrix (3 scenarios)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 75 | Every adapter publishes capabilities | PASS | `test_adapters.py::test_every_adapter_publishes_capabilities[...]` (8 adapters). `test_capabilities.py::test_default_capabilities_are_conservative`. |
| 76 | dtmf() raises UnsupportedCapabilityError on non-telephony | PASS | `test_script_steps.py::test_dtmf_on_non_telephony_raises_unsupported_capability_error` + `test_capabilities.py::test_error_names_adapter_and_capability`. |
| 77 | Capability matrix rendered in adapter docs | MISSING | No capability matrix in `docs/docs/pages/` — `grep -ri "capability matrix" docs/docs/` returns nothing. `docs/docs/pages/examples/multimodal/testing-voice-agents.mdx` exists but has no matrix. Only `test_capabilities.py::test_error_message_points_to_capability_matrix_docs` asserts *error message* references docs — the docs themselves don't contain the matrix. |

### VAD Fallback (3 scenarios)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 78 | SDK-side VAD fallback for no native_vad | PASS | `test_vad.py::test_vad_detects_silence_to_voice_to_silence_transitions`, `::test_vad_with_silence_only_never_fires_speech_start`. |
| 79 | VAD fallback emits one-shot UserWarning | PASS | `test_vad.py::test_vad_fallback_emits_userwarning_once_per_adapter`, `::test_vad_fallback_warns_per_adapter_name`. |
| 80 | Native-VAD adapters do NOT trigger fallback | UNVERIFIED | `test_vad.py` verifies fallback fires when `native_vad=False`. No test asserts webrtcvad is NOT invoked when `native_vad=True`. Implementation likely correct (early-return on capabilities check) but unasserted. |

### Local Playback (2 scenarios)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 81 | audio_playback=True spawns ffmpeg subprocess with audio-output driver | PASS | `test_playback.py::test_platform_output_args_matches_host_platform`, `::test_ffmpeg_playback_has_safe_default_state`. |
| 82 | Playback degrades gracefully on headless systems | PASS | `test_playback_degradation.py::test_start_failure_sets_inactive_and_logs_at_debug`, `::test_feed_after_failed_start_is_noop`, `::test_feed_tolerates_broken_pipe`, `::test_stop_on_unstarted_playback_is_safe`. |

### Audio in any role (1 scenario)

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| 83 | Audio works in assistant-role messages | PASS | `test_messages.py::test_audio_works_cleanly_in_assistant_role`, `::test_create_audio_message_round_trips_chunk`, `::test_transcript_preserved_alongside_audio`. |

---

## Verdict summary

| Status | Count | % |
|---|---|---|
| PASS | 52 | 62.7% |
| DEFERRED | 7 | 8.4% |
| UNVERIFIED | 19 | 22.9% |
| MISSING | 1 | 1.2% |
| INTEGRATION-ONLY | 4 | 4.8% |
| **TOTAL** | **83** | **100%** |

**52 PASS / 7 DEFERRED / 19 UNVERIFIED / 1 MISSING / 4 INTEGRATION-ONLY out of 83.**

## Most concerning findings

1. **#77 Capability matrix not in docs (MISSING).** The error message references a docs capability matrix that does not exist. User-facing contract gap.
2. **#58 Example 6.5 (tool-call callable step).** Source explicitly flags "NOT OPTIONAL." No test verifies the callable-as-step pattern with `state.timeline` access. Potentially implemented via plain Python but unasserted.
3. **Examples 6.1-6.8 (#54-#61): 7 of 8 end-to-end examples UNVERIFIED.** Only 6.1 has an example script; none have integration tests that run in CI or unit tests composing the pattern. The proposal's "show it works end-to-end" promise is unproven.
4. **Pain patterns §8 (#62-#66): all 5 UNVERIFIED.** These are the user-value reasons for the whole feature. No pain-pattern is composed in a test.
5. **#22 Judge always includes transcripts (UNVERIFIED).** The "always" guarantee is a contract; no test asserts it. `include_audio` logic is tested but the transcript-attachment always-path is not.
6. **#44 on_turn hook for varying effects (UNVERIFIED, possibly MISSING).** `grep on_turn` on `scenario_executor.py` returns nothing. May not be implemented at all.
7. **#80 Native-VAD adapters do NOT trigger fallback (UNVERIFIED).** The negative case is untested — webrtcvad could still be invoked on a native-VAD adapter and nothing would catch it.

## Process notes

- `CI=true` skips 9 tests (all under `test_agent_wait_false.py`, `test_executor_lifecycle.py`, `test_hooks.py`) that drive `scenario.run` and hang in GitHub Actions. The test authors marked these as skipped with a clear reason; they pass locally. Counted as PASS here since the code path is verified, just not in CI.
- Pytest-BDD wiring is deferred (PR body #12). Without it, any classification as PASS reflects *inferred* coverage of the Gherkin scenario by matching pytest tests — not literal execution of the scenario text.
- 8 example scripts under `python/examples/` partially back the §6 E2E ACs but do not run in the CI pytest voice suite and do not assert Gherkin `Then` clauses programmatically.
