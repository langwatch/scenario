# Ralph Prompt — Issue #350 Voice Agents

Implement voice agent support in the Scenario Python SDK. Done when all 83 scenarios in `specs/voice-agents.feature` pass.

## Sources (read in order)

1. `specs/voice-agents.feature` — the contract. Every scenario cites a proposal line range in a comment.
2. `docs/proposals/issue-350-delivery-plan.md` — phase breakdown, files, deps, locked decisions.
3. `docs/proposals/issue-350-voice-agents-INDEX.md` — navigation map. Use `Read(offset, limit)` for source sections; don't read the full 1346-line source.
4. `docs/proposals/issue-350-voice-agents-source.md` — authoritative proposal.
5. `docs/proposals/issue-350-open-questions-resolved.md` — recommendations for implementer-level calls.

## Locked decisions (do not relitigate)

1. `AudioChunk` is PCM16 @ 24kHz mono. Adapters convert at send/recv.
2. TTS cache key: `(text, voice)`. Effects applied post-cache.
3. `interrupt(after_words=N)` raises `UnsupportedCapabilityError` on adapters without streaming transcripts.
4. Hard deps, no extras. `imageio-ffmpeg` bundles ffmpeg.
5. Pluggable `STTProvider`, default OpenAI `gpt-4o-transcribe`.
6. VAD fallback: `webrtcvad-wheels` with one-shot warning on activation.
7. ~1MB bundled CC0 noise samples ship with core.
8. Playback: `ffplay` subprocess, graceful no-op on headless.

## Capability matrix (required)

Every adapter publishes `adapter.capabilities: AdapterCapabilities` with `streaming_transcripts`, `native_vad`, `dtmf`, `input_formats`, `output_formats`. Capability-gated steps check and raise cleanly.

## Scope

- Python SDK only. No TypeScript, no JavaScript edits. Parity is a follow-up.
- Phases run in order (Core → Platforms → Interruptions → Effects → Observability). Don't start N+1 until N's scenarios pass.
- Write failing test first, then minimum code to pass.

## Implementer-level calls (decide, document in PR, move on)

- Multimodal audio encoding per judge provider.
- Cache storage location (reuse `scenario.cache` joblib dir).
- `InterruptionConfig(strategy="contextual")` prompt.
- `LatencyMetrics.time_to_first_byte` semantics.
- `OpenAIRealtimeAgent(role=AgentRole.USER)` + scripted `user("text")` routing.
- WebRTC client: `aiortc` direct (not `pipecat-ai`).
- 25-min `gpt-4o-transcribe` guard with chunking.

## Rules

- Proposal is authoritative. Don't summarize it, don't invent scope.
- If the proposal is ambiguous, read the cited section and resolve from there.
- If a decision must be made and isn't covered above, pick the simplest option that passes the AC, document in PR, move on.
- Commit per phase. Commit messages reference scenarios made passing.
- All `@unit` scenarios must pass in CI without live creds. `@integration` gated by API key presence check (match existing convention in `python/tests/test_red_team_agent.py:1210-1216`).
