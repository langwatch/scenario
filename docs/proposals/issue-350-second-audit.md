# Issue #350 — Second Faithfulness Audit

**Auditor:** Fresh-eyes agent, no prior context from planning agent.
**Date:** 2026-04-15
**Scope:** All five planning artifacts cross-checked against the source proposal and the Python codebase.

---

## Findings

### [SEVERITY: high] Open-questions Q8 recommends `sounddevice` but Locked Decision #8 is `ffplay`

**Artifact:** `docs/proposals/issue-350-open-questions-resolved.md`, lines 156–169 (Q8)
**Claim:** "The delivery plan lists `sounddevice>=0.4` as a hard dep but flags this question." Recommends keeping `sounddevice` (portaudio) as the primary backend. Describes `ffplay` as a fallback option with "worse latency."
**Reality:** (1) The delivery plan does NOT list `sounddevice` as a hard dep — the dep list section has no sounddevice entry. (2) Locked Decision #8 explicitly reads: "`ffplay` subprocess, graceful no-op on headless." The delivery plan's locked decision #8 restates this verbatim: "No `sounddevice`/PortAudio dep." The open-questions doc is recommending a design that was already decided against.
**Category:** contradiction
**Fix:** Replace Q8 entirely. The decision is already locked as `ffplay`. Q8 should note that the delivery plan already encodes the chosen backend and is not open for re-deliberation. Remove the false premise that the delivery plan "lists `sounddevice>=0.4` as a hard dep."

---

### [SEVERITY: high] Delivery plan `config.py` path does not exist — it's a directory

**Artifact:** `docs/proposals/issue-350-delivery-plan.md`, Phase 5, line 78
**Claim:** "Files to modify: `python/scenario/config.py` — global `audio_playback: bool` config"
**Reality:** `python/scenario/config.py` does not exist. The actual config is a package at `python/scenario/config/` with submodules `__init__.py`, `langwatch.py`, `logging.py`, `model.py`, `scenario.py`. The correct modification target is likely `python/scenario/config/scenario.py` (where `ScenarioConfig` lives, already contains `headless` field).
**Category:** hallucination (invented file path)
**Fix:** Change to `python/scenario/config/scenario.py` — add `audio_playback: bool = False` to `ScenarioConfig`.

---

### [SEVERITY: high] "babble" bundled as a `background_noise` preset — not in source

**Artifact:** `docs/proposals/issue-350-delivery-plan.md`, line 68 (Phase 4), line 100 (Locked Decision #7); `specs/voice-agents.feature`, line 560
**Claim:** Both the delivery plan and feature file list five bundled noise samples including `babble` for use with `background_noise`: "cafe, street, office, airport, babble."
**Reality:** The source (L521) lists `background_noise` presets as: `(cafe, street, office, airport)` — four presets. "babble" appears only in the `multiple_voices(background_audio)` effect (L533), which "Mix with speech babble sample" — it is a different effect, not a named preset for `background_noise`. The ralph-prompt's locked decision #7 says "~1MB bundled CC0 noise samples" without enumerating names.
**Category:** distortion (scope creep from a related effect)
**Fix:** In delivery plan Phase 4 file path, change `cafe,street,office,airport,babble` to `cafe,street,office,airport`. In feature file line 560, remove `babble` from the `background_noise` preset list. Babble audio may still be needed for `multiple_voices` but is a separate file. Do not expose it as a `background_noise("babble")` preset unless the source explicitly supports it.

---

### [SEVERITY: high] Decision numbering in delivery plan and feature file is misaligned with ralph-prompt

**Artifact:** `docs/proposals/issue-350-delivery-plan.md`, lines 18, 19, 57, 71, 84, 179, 183, 203, 236; `specs/voice-agents.feature`, lines 107, 141, 289, 296
**Claim:** These artifacts label decisions as "Resolved Decision #1" (interrupt/UnsupportedCapabilityError), "Resolved Decision #2" (AudioChunk), "Resolved Decision #3" (TTS cache key), "Resolved Decision #4" (hard deps).
**Reality:** The ralph-prompt (ground truth) enumerates the same decisions in a different order:
- Locked #1 = AudioChunk PCM16 @ 24kHz
- Locked #2 = TTS cache key
- Locked #3 = interrupt UnsupportedCapabilityError
- Locked #4 = Hard deps
- Locked #5–8 = STT, VAD, noise, playback

The artifacts' "Resolved Decision #2" = ralph's Locked #1, etc. An implementer reading the ralph-prompt to verify a "Resolved Decision #2" claim will find a different decision (TTS cache key, not AudioChunk).
**Category:** contradiction
**Fix:** Either (a) align all artifacts to use the ralph-prompt's numbering, or (b) switch to descriptive names ("AudioChunk decision," "TTS cache decision," etc.) instead of opaque numbers. Option (b) is preferred since numbers are fragile. The ralph-prompt itself is the authoritative numbering source.

---

### [SEVERITY: medium] Open-questions Q8 premise is false: delivery plan never listed `sounddevice` as a hard dep

**Artifact:** `docs/proposals/issue-350-open-questions-resolved.md`, line 156
**Claim:** "The delivery plan lists `sounddevice>=0.4` as a hard dep but flags this question."
**Reality:** The delivery plan dependency section (lines 85–97) does not include `sounddevice` anywhere. This is a hallucinated premise that misrepresents the delivery plan's content. (This is a sub-finding of the Q8 contradiction above but worth calling out separately as a factual error about the delivery plan.)
**Category:** hallucination
**Fix:** Remove the false premise. The delivery plan lists `imageio-ffmpeg`, `numpy`, `soundfile`, `webrtcvad-wheels`, `websockets`, `aiortc`, `twilio`, `livekit`, `livekit-api`, `elevenlabs`, `google-cloud-texttospeech`, `cartesia`. No `sounddevice`.

---

### [SEVERITY: medium] Feature file Background section missing `webrtcvad-wheels` from hard deps list

**Artifact:** `specs/voice-agents.feature`, line 9
**Claim:** "voice dependencies (ffmpeg via imageio-ffmpeg, numpy, soundfile) are installed as hard deps"
**Reality:** Locked Decision #6 makes `webrtcvad-wheels` a hard dep: "VAD fallback: `webrtcvad-wheels` with one-shot warning on activation." The delivery plan dep list (line 88) confirms it. The Background's hard-dep declaration omits it.
**Category:** contradiction (omission)
**Fix:** Change line 9 to: `And voice dependencies (ffmpeg via imageio-ffmpeg, numpy, soundfile, webrtcvad-wheels) are installed as hard deps`

---

### [SEVERITY: medium] Delivery plan lists Google TTS and Cartesia under "Hard deps" with optional-gating caveat — contradicts no-extras decision

**Artifact:** `docs/proposals/issue-350-delivery-plan.md`, lines 84, 94–95
**Claim:** Section header says "Hard dependencies (no `extras`, per Resolved Decision #4)" but then lists `google-cloud-texttospeech>=2.16` and `cartesia>=1.0` with the caveat "optional, gate by runtime check if the user picks `google/...`".
**Reality:** These two entries are structurally inconsistent with the "no extras" locked decision. If they are hard deps, they install unconditionally. If they gate by runtime check, they are optional/soft deps. The source (L271-280) just shows a routing table without specifying dep strategy for these providers. The locked decision #4 ("Hard deps, no extras") is about voice infrastructure deps (ffmpeg, numpy, etc.), not necessarily about every possible TTS provider.
**Category:** contradiction (internal to delivery plan)
**Fix:** Either (a) move these two entries under a separate "Soft/lazy-import deps" section with explicit note that they are imported only when the provider is used, OR (b) remove them from the dep list entirely and note in `tts.py` that missing provider deps raise a clear `ImportError` at call time. Do not list them under the "Hard deps (no extras)" section with conditional caveats.

---

### [SEVERITY: medium] Open-questions Q1: "Segment any audio > 20 min" — threshold is inconsistent with the 25-minute limit

**Artifact:** `docs/proposals/issue-350-open-questions-resolved.md`, line 13
**Claim:** "Segment any audio > 20 min into < 25 min chunks to stay under the API limit."
**Reality:** The ralph-prompt implementer question #7 says "25-min `gpt-4o-transcribe` guard." The feature file (line 588) says "Given an audio turn exceeding 25 minutes." The actual OpenAI limit is 25 minutes. Triggering chunking at 20 minutes introduces a 5-minute early-trigger that isn't justified in either the source or the locked decisions. The feature AC says "audio exceeding 25 minutes is chunked" — an implementation that chunks at 20 minutes passes the AC but may cause unnecessary chunking in tests.
**Category:** distortion
**Fix:** Change "any audio > 20 min" to "any audio approaching 25 min (i.e., > 24 min 30 s to be safe)" or simply "any audio exceeding 25 min per-turn." The current 20-min threshold is an arbitrary invention.

---

### [SEVERITY: medium] Delivery plan Phase 1 says `OpenAIRealtimeAgent` "already partially exists" — not true in Python SDK

**Artifact:** `docs/proposals/issue-350-delivery-plan.md`, line 11 (via source §10 L1311)
**Claim:** Source §10 L1311 says "OpenAIRealtimeAgent (already partially exists)." The delivery plan references this in Phase 1.
**Reality:** `grep -r "OpenAIRealtime" python/` finds zero Python files. The comment "already partially exists" refers to the JavaScript examples (openai-realtime-demo, voice agent tests), not Python. No Python implementation exists. The delivery plan propagates this claim without verifying it against the Python codebase.
**Category:** hallucination (about codebase state)
**Fix:** Remove or qualify "already partially exists." Phase 1 should treat `OpenAIRealtimeAgent` as a net-new Python implementation. The JavaScript reference code exists and can be used as design guidance, but the Python class does not exist yet.

---

### [SEVERITY: low] INDEX §6.1 line range is `874–900` but section starts at L874 and ends closer to L899

**Artifact:** `docs/proposals/issue-350-voice-agents-INDEX.md`, line 51
**Claim:** "6.1 | Basic voice conversation | 874–900"
**Reality:** Source L874 is `### 6.1 Basic voice conversation`, source L899 is `result.audio.save("test_output/greeting.wav")`, and L900 is blank. L901 is `### 6.2`. The boundary is trivially off by one (900 is blank). Not a material error.
**Category:** wrong-line-range (negligible)
**Fix:** Minor: change to `874–899` for precision.

---

### [SEVERITY: low] INDEX §5.7 line range: `829–871` but section content ends at L868

**Artifact:** `docs/proposals/issue-350-voice-agents-INDEX.md`, line 43
**Claim:** "5.7 | Custom HTTP/WebSocket | 829–871"
**Reality:** §5.7 starts at L829 ("### 5.7 Custom HTTP/WebSocket") and its last code block closes at L868. L870 is `---` and L872 starts §6. The range `829–871` captures the `---` separator, which is not section content.
**Category:** wrong-line-range (negligible)
**Fix:** Minor: change to `829–870` or `829–868`.

---

### [SEVERITY: low] Feature file scenario at line 303-308 says `proceed(turns=5, interruptions=InterruptionConfig(...))` — source shows `scenario.proceed(turns=5, interruptions=...)`

**Artifact:** `specs/voice-agents.feature`, lines 303–308
**Claim:** "Given proceed(turns=5, interruptions=InterruptionConfig(probability=0.3, delay_range=(0.5,3.0), strategy="contextual"))"
**Reality:** Source L482-492 shows `scenario.proceed(...)` with both strategies on separate lines in the same dict, not as a union. The feature file's AC is accurate in substance but collapses the two strategies into one Given — which is fine as a Gherkin scenario boundary description.
**Category:** distortion (minor compression, no implementation impact)
**Fix:** No change needed — Gherkin compression of the API is acceptable.

---

## Summary counts

| Category | High | Medium | Low |
|---|---|---|---|
| Hallucination | 2 | 1 | 0 |
| Contradiction | 2 | 2 | 0 |
| Distortion | 1 | 1 | 1 |
| Scope-creep | 0 | 0 | 0 |
| Wrong-line-range | 0 | 0 | 2 |
| **Total** | **5** | **4** | **3** |

---

## Overall verdict

**Needs fixes** — not a rewrite. The proposal is broadly faithful and well-structured. Most scenarios are correct. Four high-severity issues must be resolved before the ralph loop starts; two of them (`sounddevice` in Q8, `babble` as `background_noise` preset) would cause an implementer to build the wrong thing.

---

## Top 5 fixes by priority

1. **[Q8 contradiction]** Rewrite `open-questions-resolved.md` Q8: the playback backend is already locked as `ffplay`. Remove the `sounddevice` recommendation entirely and the false claim that the delivery plan ever listed it.

2. **[babble distortion]** Remove `babble` from the `background_noise` preset list in both delivery plan Phase 4 paths (`python/scenario/voice/assets/noise/`) and feature file line 560. Babble audio supports `multiple_voices`, not `background_noise`.

3. **[config.py hallucination]** Fix delivery plan Phase 5 file path from `python/scenario/config.py` to `python/scenario/config/scenario.py`.

4. **[decision numbering contradiction]** Resolve the "Resolved Decision #N" numbering mismatch between delivery plan / feature file and the ralph-prompt's locked decision numbering. Adopt descriptive names or align to ralph-prompt order.

5. **[webrtcvad-wheels omission]** Add `webrtcvad-wheels` to the feature file's Background hard-deps declaration (line 9).
