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
8. Playback: `ffmpeg` subprocess (bundled binary) with platform audio-output driver. Graceful no-op on headless. Not `ffplay` — `imageio-ffmpeg` does not bundle ffplay.

## Planning-level additions (NOT in the source proposal)

These were added during planning to fill gaps in the proposal. They are authoritative for this PR but are NOT traceable to source line ranges. Layer 3 (proposal fidelity) check should treat these as exceptions — verify against the locked decisions, not against source.

1. **Adapter Capability Matrix** — `AdapterCapabilities` dataclass + `UnsupportedCapabilityError`. Machinery for locked decision #3 (after_words raises). Proposal implies capability heterogeneity (§5 per-platform differences) but does not define a publishable schema.

2. **Pluggable `STTProvider` interface** — proposal (§4.3 L324) says "automatic STT" but never names a provider or defines an interface. Our design: pluggable interface, OpenAI default, swap via `scenario.configure(stt=...)`.

3. **SDK-side VAD fallback** — proposal (§4.3) assumes VAD events come from the adapter. It does NOT say the SDK should provide a fallback for adapters without native VAD. Our addition via `webrtcvad-wheels` + one-shot warning. "Polish wins" — user-approved.

4. **Audio format normalization to PCM16 @ 24kHz mono** — proposal shows different formats per adapter (mulaw/8000 for Twilio, PCM16/24000 for ElevenLabs). We chose a single canonical internal format to reduce combinatorial complexity at adapter boundaries. Proposal-adjacent, not contradicted.

5. **Hard deps (no extras) install strategy** — proposal is silent on install model. We chose "voice is first-class, zero setup."

6. **Bundled noise samples ship with core package** — proposal §4.5 L546 says "framework bundles ~5 WAVs" without specifying packaging. We chose "in core package" over "separate install."

7. **Playback via `ffmpeg` subprocess** — proposal §4.7 mentions `audio_playback=True` without specifying a backend. `ffmpeg` chosen to reuse the bundled binary; `ffplay` not used because `imageio-ffmpeg` doesn't bundle it.

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

## Three-layer convergence check (run at the end of every loop iteration)

Before declaring an iteration done, verify all three layers. A green test alone is not sufficient — hallucinations pass green tests.

**Layer 1 — Feature file (scenarios pass):**
- Run the tests for scenarios touched this iteration. They pass.
- No regressions in previously-passing scenarios.

**Layer 2 — AC semantics (behavior is right, not green-by-cheating):**
- For each scenario just made passing, re-read the Gherkin text. Does the implementation actually satisfy the *intent* of the AC, not just the literal assertions?
- Examples of cheating the green: mocking out the thing the AC is supposed to test; returning a hardcoded value that happens to match; skipping the assertion that would fail.
- If you caught yourself doing any of these, the scenario isn't really passing — fix it.

**Layer 3 — Proposal fidelity (no drift from source):**
- For each scenario touched this iteration, check its source citation:
  - If cited (`# Source §X.Y, Lxxx-yyy`): read via `docs/proposals/issue-350-voice-agents-INDEX.md` → `Read(docs/proposals/issue-350-voice-agents-source.md, offset=xxx, limit=N)`. Verify the implementation matches what the **original proposal** actually says.
  - If not cited: the scenario implements one of the 7 planning-level additions (see list above). Verify consistency with the locked decisions, not with source.
- The proposal wins over the feature file. If an AC drifted from the proposal during planning, document the mismatch in the PR and update the feature file with a note.
- Do NOT flag the 7 listed planning-level additions as drift — they are authorized.

**Why this matters:** Prior planning of this feature introduced 14+ distortions of the original proposal during summarization. Every implementation iteration must re-verify against the source to prevent the same drift from re-entering at the code level.
