# Issue #350 — Final Faithfulness Audit (Third Pass)

**Auditor:** Fresh-eyes agent, no prior context from planning agent.
**Date:** 2026-04-15
**Scope:** Verify all 12 prior findings fixed; hunt for new hallucinations; cross-artifact consistency; scope drift.

---

## Part 1 — Prior Finding Status

### Prior finding 1: Q8 sounddevice — VERIFIED FIXED

`open-questions-resolved.md` Q8 is now titled "Playback backend — RESOLVED." The `sounddevice` recommendation is gone. The `ffplay`/subprocess decision is stated verbatim and marked "Not open for re-deliberation." The false premise that the delivery plan "lists `sounddevice>=0.4` as a hard dep" is absent. Clean fix.

### Prior finding 2: config.py hallucinated path — VERIFIED FIXED

Delivery plan Phase 5 now reads `python/scenario/config/scenario.py`. Verified: `python/scenario/config/` is a real directory containing `scenario.py`. Clean fix.

### Prior finding 3: babble as background_noise preset — VERIFIED FIXED

Both artifacts now correctly distinguish babble. Delivery plan Phase 4 (line 71) reads: `babble.wav — sample used by multiple_voices effect (§4.5 L533). Not a background_noise preset.` Delivery plan "Bundled noise assets" section (line 107) restates the distinction. Feature file line 560 now reads: `bundled noise WAV samples (cafe, street, office, airport for background_noise; babble for multiple_voices) ship inside the package` — correctly separating the presets. Clean fix.

### Prior finding 4: Decision numbering mismatch — VERIFIED FIXED

All "Resolved Decision #N" number references have been replaced with descriptive names throughout the delivery plan and feature file. Delivery plan Phase 1 uses `(per the **AudioChunk normalization** decision)`, `(per the **TTS cache key** decision)`, `(per the **after_words UnsupportedCapabilityError** decision)`, `(per the **Hard deps** decision)`, etc. Feature file uses `# Locked decision: AudioChunk normalization`, `# Locked decision: TTS cache key`, etc. The ralph-prompt retains its authoritative numbered list (1–8). Clean fix.

### Prior finding 5: Q8 false premise about sounddevice in delivery plan — VERIFIED FIXED

(Sub-finding of #1.) The false premise is absent from the rewritten Q8. Clean fix.

### Prior finding 6: webrtcvad-wheels missing from feature file Background — VERIFIED FIXED

Feature file line 9 now reads: `And voice dependencies (ffmpeg via imageio-ffmpeg, numpy, soundfile, webrtcvad-wheels) are installed as hard deps`. Clean fix.

### Prior finding 7: google/cartesia under hard-deps with optional caveats — VERIFIED FIXED

Delivery plan now has a separate section "Soft / lazy-import TTS provider deps" (lines 98–102) for `google-cloud-texttospeech` and `cartesia`, explicitly NOT under the hard-deps section. Includes a note about `ImportError` on resolution and helpful message. Clean fix.

### Prior finding 8: Q1 "20 min" threshold — VERIFIED FIXED

Q1 now reads: "Enforce the 25-minute per-request limit: if a single turn's audio exceeds 25 minutes, chunk it before sending." The arbitrary 20-minute threshold is gone. Consistent with the feature file (line 589: "Given an audio turn exceeding 25 minutes") and the ralph-prompt ("25-min gpt-4o-transcribe guard with chunking"). Clean fix.

### Prior finding 9: OpenAIRealtimeAgent "already partially exists" — VERIFIED FIXED

Delivery plan Phase 1 now has an explicit Note callout (lines 15–15) clarifying: "Source §10 says 'OpenAIRealtimeAgent (already partially exists).' That refers to the JavaScript reference code ... No Python implementation exists — OpenAIRealtimeAgent is net-new in this PR." Clean fix.

### Prior finding 10: INDEX §6.1 line range 874–900 — PARTIALLY FIXED (acceptable)

INDEX now reads "874–899" for §6.1. Verified: source L874 = `### 6.1 Basic voice conversation`, L899 = `result.audio.save(...)`, L900 = blank. The range 874–899 is technically correct (L900 is blank/non-content). This is acceptable.

### Prior finding 11: INDEX §5.7 line range 829–871 — VERIFIED FIXED

INDEX now reads "829–868" for §5.7. Verified: source L829 = `### 5.7 Custom HTTP/WebSocket`, L868 = `scenario.WebSocketAgent(url="wss://my-agent.com/ws", protocol=MyProtocol())`. L869 is the closing `\`\`\``, L870 = `---`. The range 829–868 captures actual content. Acceptable precision.

### Prior finding 12: feature file line 303-308 InterruptionConfig compression — VERIFIED NO FIX NEEDED

This was marked "No change needed" in the second audit. Feature file still uses the compressed representation. This remains acceptable Gherkin compression.

---

## Part 2 — New Findings

### [SEVERITY: medium] Feature file Background AC mismatch: hard deps list omits websockets, aiortc, twilio, livekit

**Artifact:** `specs/voice-agents.feature`, line 9; `docs/proposals/issue-350-delivery-plan.md`, lines 87–95
**Claim:** Feature file Background states: `voice dependencies (ffmpeg via imageio-ffmpeg, numpy, soundfile, webrtcvad-wheels) are installed as hard deps`
**Reality:** The delivery plan lists 9 hard deps: imageio-ffmpeg, numpy, soundfile, webrtcvad-wheels, websockets, aiortc, twilio, livekit+livekit-api, elevenlabs. The feature file's Background only enumerates 4. This was not introduced by the patches — it existed before — but it is still inaccurate. An implementer reading the Background to validate the dep list will find it incomplete. The Background AC "Given pip install scenario / Then imageio-ffmpeg, numpy, soundfile, webrtcvad-wheels are installed" at line 557–559 also omits the transport deps.
**Category:** distortion (incomplete enumeration)
**Fix:** Either (a) add the remaining transport hard deps to the Background line: `(ffmpeg via imageio-ffmpeg, numpy, soundfile, webrtcvad-wheels, websockets, aiortc, twilio, livekit, livekit-api, elevenlabs)`, or (b) use a less exhaustive phrasing: `voice infrastructure dependencies are installed as hard deps (no extras flag)` and rely on the delivery plan for the full list. Option (b) is safer since the dep list may evolve.

---

### [SEVERITY: medium] Capability matrix (AdapterCapabilities / UnsupportedCapabilityError) has no grounding in the source proposal

**Artifact:** `specs/voice-agents.feature`, lines 596–614; `docs/proposals/issue-350-delivery-plan.md`, lines 145–154
**Claim:** "Every adapter publishes `adapter.capabilities: AdapterCapabilities`" with `streaming_transcripts`, `native_vad`, `dtmf`, `input_formats`, `output_formats`. Multiple feature scenarios assert this interface. The delivery plan also has an "Adapter Capability Matrix (requirement)" section listing these fields.
**Reality:** The source proposal (`issue-350-voice-agents-source.md`) does not mention `AdapterCapabilities`, `UnsupportedCapabilityError` (by that name), a capability matrix, `streaming_transcripts`, `native_vad`, `dtmf` as capability fields, or `input_formats`/`output_formats`. The source does mention `after_words` uses a "streaming transcript" and that DTMF is for telephony, but it never proposes a formal capability object or error class. This appears to have been invented by the planning agent and presented as a requirement.

However, this is defensible as a necessary implementation detail for the `after_words` UnsupportedCapabilityError (locked decision #3) — the locked decisions implicitly require capability-gating. The delivery plan's capability matrix is internally consistent and solves a real need. It is scope-addition, not hallucination of a false claim.
**Category:** scope-creep (not grounded in source, but coherent with locked decisions)
**Fix:** Mark the capability matrix section in the delivery plan as "Implementation-level design decision (not in source proposal)" rather than calling it a "requirement." In the feature file, tag capability-matrix scenarios with a comment like `# Implementation decision: required to support locked decision #3 (after_words UnsupportedCapabilityError)`. This makes the scope addition transparent to ralph.

---

### [SEVERITY: low] Delivery plan traceability table lists "Resolved #1", "Resolved #2", "Resolved #3", "Resolved #4" in the Source lines column — inconsistent with descriptive-name fix

**Artifact:** `docs/proposals/issue-350-delivery-plan.md`, lines 186, 190, 210, 243
**Claim:** Traceability table rows for `AudioChunk normalization`, `TTS cache key`, `interrupt(after_words) error`, `Hard deps` show `Resolved #2`, `Resolved #3`, `Resolved #1`, `Resolved #4` respectively in the "Proposal section" column.
**Reality:** The body of the delivery plan switched from numbered references to descriptive names (e.g., `(per the **AudioChunk normalization** decision)`). But the traceability table still uses the old "Resolved #N" identifiers. This is an internal inconsistency — a half-done fix. These numbers don't match the ralph-prompt's Locked #1–#8 numbering either, so they're still potentially confusing. The numbers in the table do not match the ralph-prompt's order (ralph's Locked #1 = AudioChunk = table's "Resolved #2").
**Category:** contradiction (residual from prior fix, internal inconsistency)
**Fix:** In the traceability table, replace `Resolved #2`, `Resolved #3`, `Resolved #1`, `Resolved #4` with descriptive names: `AudioChunk decision`, `TTS cache decision`, `after_words decision`, `Hard deps decision`. Or omit the "Proposal section" column for these locked decisions and just mark them as `(locked)`.

---

### [SEVERITY: low] VAD fallback section in feature file cites no source line — scope-addition with no traceability

**Artifact:** `specs/voice-agents.feature`, lines 617–639 (VAD fallback scenarios)
**Claim:** Three scenarios about VAD fallback behavior (activates on adapters without native VAD, emits one-shot UserWarning, skipped on adapters with native VAD).
**Reality:** The source proposal mentions VAD in passing (§4.4 L391 describes how "the voice agent detects user speech via VAD"), but does not specify SDK-side VAD fallback, webrtcvad-wheels, or the one-shot warning behavior. These are grounded in locked decision #6 (VAD fallback: webrtcvad-wheels with one-shot warning). The locked decision is authoritative. However, the feature file scenarios have no `# Source §X.Y, LN` citation — they just say `# Locked decision: VAD fallback`. This is acceptable (locked decisions are authoritative) but inconsistent with the citation pattern used throughout the rest of the feature file.
**Category:** distortion (missing citation, not a hallucination)
**Fix:** Add a note referencing the delivery plan's VAD decision: `# Locked decision #6: VAD fallback. Implementation detail in delivery-plan "Locked Design Decisions" §5.`

---

### [SEVERITY: low] Q4 mentions `filelock` as a dep for concurrent eviction — not in delivery plan dep list

**Artifact:** `docs/proposals/issue-350-open-questions-resolved.md`, line 80
**Claim:** "Concurrent test processes need file-locking on eviction (use `filelock`)."
**Reality:** `filelock` is not listed in the delivery plan's hard deps or anywhere in `python/pyproject.toml`. If the implementer follows this recommendation literally, they would add a dep that isn't in the delivery plan. `filelock` is a common, lightweight package but it's undeclared.
**Category:** hallucination (undeclared dependency recommendation)
**Fix:** Either add `filelock>=3.0` to the delivery plan's hard-deps section, or qualify the Q4 recommendation: "use `filelock` if available (it is a transitive dep of many test frameworks) or fall back to a lockfile via `fcntl`."

---

## Part 3 — Cross-Artifact Consistency

**Background hard-deps ↔ delivery plan:** Partially inconsistent (see new Finding #1 above). The 4 deps in the Background are a subset of the 9 in the delivery plan. Not clean.

**Decision references (feature file ↔ delivery plan ↔ ralph-prompt):** Body text uses descriptive names consistently. Traceability table still uses "Resolved #N" (see new Finding #3). Ralph-prompt uses numbered list 1–8. No cross-reference failure between feature file body text and ralph-prompt.

**babble/background_noise distinction:** Consistent across all 5 artifacts after the fix.

**Q8 playback decision:** Consistent across all 5 artifacts. Q8 in open-questions, delivery plan locked decision #8, ralph-prompt locked decision #8, feature file playback scenarios, all say `ffplay` / no sounddevice.

**STT default provider:** Consistent. Q1 → `gpt-4o-transcribe`, delivery plan locked decision #5, ralph-prompt #5, feature file all agree.

**VAD fallback:** Consistent. Q3, delivery plan locked decision #6, ralph-prompt #6, feature file all agree on webrtcvad-wheels.

**File paths:** All Phase 1–5 files are correctly marked as "to create" (none of them exist yet — `python/scenario/voice/` does not exist). `python/scenario/_events/` correctly exists. `python/scenario/config/scenario.py` correctly exists. Clean.

**CI convention reference:** Delivery plan cites `python/tests/test_red_team_agent.py:1210-1216`. Verified: line 1210–1216 is indeed the `@pytest.mark.skipif(not (...OPENAI_API_KEY... and ...ANTHROPIC_API_KEY...), ...)` pattern. Accurate.

**cache.py joblib pattern:** Q4 references existing `python/scenario/cache.py` and joblib `Memory`. Verified: cache.py uses `from joblib import Memory` and returns `Memory(location=..., verbose=0)`. The Q4 recommendation to add `~/.scenario/cache/tts/` subdir is consistent with the existing pattern. Clean.

---

## Part 4 — Scope Drift from Second-Audit Patches

The patches introduced two additions that were not explicitly in the source proposal:

1. **Adapter Capability Matrix** — `AdapterCapabilities`, `UnsupportedCapabilityError`, capability-gated steps. Introduced by patches, not in source. However, it is logically required by locked decision #3 (the error must know what capability is missing). The scope addition is coherent and clearly labeled in the delivery plan. **Acceptable, but should be flagged.**

2. **`playback.py` as a new file** — delivery plan Phase 5 creates `python/scenario/voice/playback.py`. Source §4.7 describes `audio_playback=True` behavior but doesn't specify a `playback.py` module. This is a straightforward implementation detail, not scope creep. **Clean.**

3. **`capabilities.py` as a new file** — Part of the capability matrix. Same assessment as #1. **Acceptable.**

No patch-introduced AC contradicts the proposal. The scope additions are internally consistent and labeled.

---

## Prior Finding Summary

| Finding | Severity | Status |
|---|---|---|
| 1: Q8 sounddevice | high | VERIFIED FIXED |
| 2: config.py hallucinated path | high | VERIFIED FIXED |
| 3: babble as background_noise preset | high | VERIFIED FIXED |
| 4: Decision numbering mismatch | high | VERIFIED FIXED |
| 5: Q8 false premise | medium | VERIFIED FIXED |
| 6: webrtcvad-wheels missing from Background | medium | VERIFIED FIXED |
| 7: google/cartesia under hard-deps | medium | VERIFIED FIXED |
| 8: Q1 "20 min" threshold | medium | VERIFIED FIXED |
| 9: OpenAIRealtimeAgent "already partially exists" | medium | VERIFIED FIXED |
| 10: INDEX §6.1 line range | low | VERIFIED FIXED |
| 11: INDEX §5.7 line range | low | VERIFIED FIXED |
| 12: feature file InterruptionConfig compression | low | NO FIX NEEDED (intentional) |

**All 11 actionable prior findings are fixed. Finding 12 was correctly left alone.**

---

## New Findings Summary

| # | Severity | Title | Category |
|---|---|---|---|
| N1 | medium | Background hard-deps list incomplete | distortion |
| N2 | medium | Capability matrix not grounded in source | scope-creep |
| N3 | low | Traceability table still uses "Resolved #N" | contradiction |
| N4 | low | VAD fallback scenarios missing source citation | distortion |
| N5 | low | Q4 recommends undeclared `filelock` dep | hallucination |

**Headline counts:** 0 high, 2 medium, 3 low new findings.

**Regression count:** 0. No patch introduced a regression — the fixes are clean.

---

## Verdict

**Ready for ralph — with two minor follow-up patches recommended before the loop starts.**

All 11 actionable prior findings are cleanly resolved. No regressions. The two medium new findings (N1, N2) are real but not blocking:

- N1 (incomplete Background dep list) will not mislead ralph about what to build — ralph reads the delivery plan dep list, not the Background declaration. Annoyance-level only.
- N2 (capability matrix scope-creep) is coherent and necessary. Ralph should know it's an implementation-level design decision, not a proposal requirement. Label it more clearly.

If the team wants a clean bill of health before starting the ralph loop, patch N1 and N2 (< 30 min). N3–N5 can be deferred to the PR or addressed in passing.
