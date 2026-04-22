# Decision: Narrow PR #355 to ElevenLabs + OpenAI Realtime happy paths

**Date**: 2026-04-22
**Author**: overnight orchardist driving from Drew's 2026-04-22 steer
**Status**: DRAFT — Drew reviews in morning
**PR**: https://github.com/langwatch/scenario/pull/355

## Decision

Narrow #355 to two first-class user happy paths:
1. **ElevenLabs** hosted Conversational AI + composable `ElevenLabsVoiceAgent` + `ElevenLabsSTTProvider`
2. **OpenAI Realtime** (`role=AGENT` and `role=USER`)

Everything not directly supporting these two moves to follow-up issues branched from this PR.

## Rationale

### Why these two

- **Client is on ElevenLabs.** Highest-priority real customer path.
- **OpenAI Realtime is the highest-demand model-as-agent case.** Different integration shape (model IS the agent vs. platform hosts the loop) — shipping both simultaneously exposes design tension one case hides.
- **Two cases > one for design quality.** Single-case integrations tend to smuggle assumptions into base classes. Two cases with different shapes force the abstractions honest.

### Why narrow now (vs. ship everything)

- The PR is ~8000+ lines and has 12 failing tests. Most failures are environmental (stale creds, flagged keys, free-tier limits) but the scope itself is also a review risk.
- Narrowing to the two target paths cuts ~14 demos + the bundled Pipecat bot infra + Twilio demos from the PR. Shrinks review surface substantially.
- Cut demos still exist in the codebase — they move to a follow-up PR branched off this one, not deleted.

### Why not split into multiple PRs (core + demos)

Drew's call: shipping code without demos has historically led to "feature exists, users can't actually use it." Demos ARE the proof that the SDK works end-to-end. Keep code + demos together.

## What stays in #355

### Code surface
- Core API: `AudioChunk`, `VoiceAgentAdapter`, `AdapterCapabilities`, capability matrix, script DSL voice extensions, effects, recording, judge voice-aware path, user simulator voice-aware path
- **ElevenLabs**: `ElevenLabsAgentAdapter` (hosted), `ComposableVoiceAgent`, `ElevenLabsVoiceAgent` (branded), `ElevenLabsSTTProvider`, ElevenLabs TTS routing
- **OpenAI Realtime**: `OpenAIRealtimeAgentAdapter` (both roles), `_find_realtime_user_agent` + `send_text` routing
- Common infra the two paths depend on: bundled noise samples, effects, hooks, latency metrics, playback, STT/TTS router

### Demos (9)
- `voice_demo_elevenlabs_hosted.py`
- `voice_demo_elevenlabs_branded.py`
- `voice_demo_openai_realtime_agent.py`
- `voice_demo_openai_realtime_user.py`
- `voice_example_6_1_basic_greeting.py` (canonical smoke)
- `voice_demo_recording_playback.py`
- `voice_demo_observability.py`
- `voice_demo_stt_swap.py`
- `voice_demo_voice_text_parity.py`

### Docs
- `docs/voice/happy-path-elevenlabs.md`
- `docs/voice/happy-path-openai-realtime.md`
- `docs/voice/capability-matrix.md` (existing)
- README voice section

## What moves to follow-up

### Platform demos + infra to cut (target: new issue ≈#374)
- `voice_demo_pipecat_ws.py` + `voice_pipecat_scenario.py` + bundled Pipecat stub bot (`python/examples/voice_pipecat_bot/`) + Makefile targets + CI steps
- `voice_demo_twilio_inbound.py` + `voice_demo_twilio_outbound.py` (adapter code stays, demos and env-probe fixtures cut to new issue)
- `voice_demo_gemini_live.py` (adapter code stays, demo moves pending key rotation)
- `voice_example_6_4_dtmf_ivr.py`
- §6.2–6.8 demos not covered by the 9 keep list (interruption recovery, angry customer, tool verification, prerecorded audio, random interruptions, silence handling)
- §8 pain pattern demos (5: long hold, accent loop, multi-intent, background handoff, emotional escalation)

### Still in #371
LiveKit, Vapi, generic WebRTC, Pipecat WebRTC transports.

### Unchanged
- #370 (epic)
- #372 (TS parity)
- #373 (traceability map)

## Consequences

### Short-term
- #355 shrinks from 25 → 9 demos, commits + CI simpler
- `@e2e` suite goes from 25 tests → ~11 tests
- 3 Twilio tests + 1 Gemini test no longer in the suite (moved to follow-up)
- 4 judge-flake §6/§8 tests no longer in the suite (moved to follow-up)

### Downside
- We lose the "bundled Pipecat stub bot = one-command self-hosted demo" value in #355. Follow-up PR lands it. Minor delay in user story completeness.
- Contract in `specs/voice-agents.feature` still references the cut demos. Either (a) trim the feature file to 9 demos in #355 and re-add in follow-up, or (b) leave the feature file as the full 25-scenario contract and note deferred. Option (b) is simpler and preserves the behavioral contract as aspirational. **NEEDS DREW: (a) or (b)?**

### Upside
- PR is reviewable end-to-end in a single session
- Failing tests in #355 drop from 12 to ~2 (judge flakes that matter for the happy paths only)
- Clear user story: "here are the two paths we ship, here are the docs"
- Follow-up PR's scope is clear: "every other demo + Pipecat bot infra"

## Implementation plan (if approved)

1. Tag current HEAD `pre-narrow-2026-04-22` as a safety point.
2. Create new branch `issue374/voice-deferred-demos` off current #355 HEAD.
3. On #355, `git rm` the 16 demo files + their e2e wrappers + the Pipecat stub bot + Makefile voice targets + CI steps. Preserve the adapter code and core surface.
4. Update `specs/voice-agents.feature` (option (a) if chosen) or add a "deferred" note (option (b)).
5. Update #355 PR body.
6. Push #374 branch, open draft PR against #355 (base = current #355 HEAD, so when #355 merges, #374 rebases cleanly onto main).
7. File the tracking issue for #374 with the feature-contract ACs the cuts cover.

Estimate: 1–2 hours to execute cleanly.

## NEEDS DREW decisions before executing

1. Approve the 9-keep / 16-cut split? (Overnight plan `ND-2`)
2. Option (a) or (b) for the feature file? (Above)
3. Should the Pipecat stub bot's **adapter code** also move to follow-up, or stay? The Pipecat WS adapter itself is shipped; only the bundled bot/infra is demo-only. My read: adapter stays, bundled bot moves.
4. Merge target for #355 still `main`? (Overnight plan `ND-6`)
5. Commit authorization: execution step 3 (`git rm` 16 files) is destructive-ish. Acceptable overnight or wait for Drew?
