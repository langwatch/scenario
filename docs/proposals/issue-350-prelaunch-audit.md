# Pre-Launch Fidelity Audit — Issue #350 Voice Agents

**Audit date:** 2026-04-15
**Prior audits:** 2 (12 + 2 findings fixed)
**This audit:** 4 new findings (0 high / 3 medium / 1 low)

---

## Findings

### [SEVERITY: medium] ffplay binary is not bundled by imageio-ffmpeg

**Artifact:** `docs/proposals/issue-350-delivery-plan.md` L82, L143; `docs/proposals/issue-350-open-questions-resolved.md` Q8; `specs/voice-agents.feature` L650; all locked-decision #8 mentions across all artifacts

**Issue:** Every artifact says "ffplay via subprocess using the bundled ffmpeg binary." This is self-contradictory. `imageio_ffmpeg.get_ffmpeg_exe()` returns a path to the `ffmpeg` binary — `ffplay` is a separate binary that imageio-ffmpeg does NOT bundle. On macOS it falls through to the system binary (which may include ffplay via Homebrew), but on a clean Linux CI runner with only imageio-ffmpeg's wheel, there is no `ffplay`. The feature scenario at L648-651 says "an ffplay subprocess is started using the bundled ffmpeg binary path" — these two facts are incompatible.

**Mitigating factor:** The "graceful no-op on headless" requirement means a missing ffplay degrades silently, so this doesn't block scenarios. But an implementer following the spec literally will write code that silently no-ops on CI when playback is expected.

**Fix:** Update the description in all three artifacts to one of:
- "Use `ffmpeg` subprocess with audio output driver (`-f alsa` / `-f pulse`) — falls back silently if no output device"; OR
- "Use `ffplay` if available on system PATH; degrade gracefully if absent. The imageio-ffmpeg binary directory does not include ffplay."

The feature scenario at L650 should drop "using the bundled ffmpeg binary path" — ffplay, if used, would come from system PATH, not the imageio-ffmpeg bundle. The `@unit` test tag is fine since this can be tested by mocking the subprocess call.

---

### [SEVERITY: medium] "Hard deps" AC only lists 4 of 9 hard dependencies

**Artifact:** `specs/voice-agents.feature` L555-561 (Scenario: "Hard dependencies install with the SDK")

**Issue:** The scenario reads:
```
Then imageio-ffmpeg, numpy, soundfile, webrtcvad-wheels are installed as hard deps
```
The delivery plan defines 9 hard deps: imageio-ffmpeg, numpy, soundfile, webrtcvad-wheels, websockets, aiortc, twilio, livekit, livekit-api, elevenlabs. An implementer could add only those 4, pass the AC, and still be missing 5 required hard deps. The Background at L9 correctly lists all of them, but that's a precondition, not a verified assertion.

**Fix:** Extend the `Then` clause to the full list:
```
Then imageio-ffmpeg, numpy, soundfile, webrtcvad-wheels, websockets, aiortc, twilio, livekit, livekit-api, elevenlabs are installed as hard deps
```

---

### [SEVERITY: medium] VAD warning text inconsistency — delivery plan specifies exact text without a docs pointer; feature AC requires one

**Artifact:** `docs/proposals/issue-350-delivery-plan.md` L141 (locked decision #6 warning text) vs `specs/voice-agents.feature` L634

**Issue:** The delivery plan specifies the exact `UserWarning` text:
> "Adapter {name} has no native VAD — using SDK-side webrtcvad. Accuracy may differ from native."

This text contains no pointer to documentation. The feature AC at L634 says:
```
And the warning points to the capability matrix docs
```
An implementer using the delivery plan's exact text verbatim would fail this AC.

**Fix:** Add a docs pointer to the delivery plan's warning text, e.g.:
> "Adapter {name} has no native VAD — using SDK-side webrtcvad. Accuracy may differ from native. See adapter capability matrix: https://..."

Or relax the feature AC to remove the docs-pointer requirement (since a URL in a warning is unusual and may rot).

Recommendation: Relax the feature AC. Change L634 from "And the warning points to the capability matrix docs" to "And the warning references accuracy differences vs native VAD" — the delivery plan text already satisfies this. The docs-pointer requirement is not in the source proposal and adds fragile coupling to a URL.

---

### [SEVERITY: low] Feature Background lists `openai` as a voice dependency being installed, but it is already a pre-existing hard dep

**Artifact:** `specs/voice-agents.feature` L9

**Issue:** The Background step reads:
```
And voice dependencies are installed as hard deps: imageio-ffmpeg, numpy, soundfile, webrtcvad-wheels, websockets, aiortc, twilio, livekit, livekit-api, elevenlabs, openai
```
The delivery plan (L104) explicitly notes `openai>=1.88` is "already a hard dep" — it is not being added as a voice dep. Including it in the list of "voice dependencies being installed" implies it is new, which could mislead an implementer into treating it as part of the voice feature's dep additions. It also creates a minor inconsistency: the delivery plan's new-dep section does not list `openai`.

**Fix:** Remove `openai` from the Background list. It is already installed. The Background should only enumerate the new deps that voice adds. Alternatively, add a parenthetical: `openai (already a core dep, listed for completeness)`.

---

## Spot-Check Citation Results (8 random citations)

All 8 passed:

| Citation | Feature claim | Source content | Result |
|---|---|---|---|
| §4.2, L249-250 | Text-only UserSimulatorAgent unchanged | L249: `scenario.UserSimulatorAgent(model=...)` without voice | MATCH |
| §4.3, L324 | "always included" transcripts | L324: "automatic STT of all audio messages (always included)" | MATCH |
| §4.4, L450-467 | `interrupt()` = `agent(wait=False)` + `sleep` + `user` | L450-467: exact equivalence shown | MATCH |
| §6.2, L901-929 | `result.latency.interrupt_response_time < 1.0` | L928: `assert result.latency.interrupt_response_time < 1.0` | MATCH |
| §6.5, L998-1028 | Callable step pattern with `assert_tool_called` | L1003-1025: exact pattern shown | MATCH |
| §8, L1267-1269 | Emotional escalation pain pattern | L1267-1269: section header + description | MATCH |
| §7.2, L1164-1171 | `role=AgentRole.USER` is CHOSEN alternative, not rejected | L1160-1171: "When to use realtime voice models instead" — presented as valid option | MATCH |
| §4.5, L536-544 | Accents via voice, no accent post-processing effect | L536-544: explicit design note, no accent effect in table | MATCH |

---

## Cross-Artifact Consistency Summary

| Locked decision | ralph-prompt | delivery-plan | feature | open-questions | Verdict |
|---|---|---|---|---|---|
| #1 PCM16 @ 24kHz mono | ✓ | ✓ | ✓ | ✓ | CONSISTENT |
| #2 TTS cache (text, voice) | ✓ | ✓ | ✓ | ✓ | CONSISTENT |
| #3 after_words → UnsupportedCapabilityError | ✓ | ✓ | ✓ | — | CONSISTENT |
| #4 Hard deps, imageio-ffmpeg | ✓ | ✓ | ✓ | — | CONSISTENT |
| #5 Pluggable STT / gpt-4o-transcribe | ✓ | ✓ | ✓ | Q1 | CONSISTENT |
| #6 VAD fallback + one-shot warning | ✓ | ✓ | partial drift | Q3 | MEDIUM FINDING #3 |
| #7 ~1MB CC0 noise samples | ✓ | ✓ | ✓ | Q5 notes 1.6MB (acknowledged) | CONSISTENT |
| #8 ffplay subprocess + graceful no-op | ✓ (ffplay) | ✓ (ffplay) | ✓ (ffplay) | LOCKED | MEDIUM FINDING #1 |

Implementer-level decisions in open-questions-resolved: all 10 are actionable and internally consistent. Q5 noise-size acknowledgment (1.6MB initial estimate > 1MB target) is handled by explicit guidance to trim to 8s/8kHz.

---

## Implementability Spot-Checks (5 random ACs)

| AC | Implementable as written? | Notes |
|---|---|---|
| "Executor calls connect() before and disconnect() after every scenario" (L98-104) | Yes | Clear lifecycle hook in scenario_executor.py |
| "TTS cache key is (text, voice) and effects apply after cache hit" (L141-146) | Yes | Clear: cache hit on (text, voice), then apply effects to cached bytes |
| "proceed(interruptions=InterruptionConfig(...)) injects ~30% interruptions" (L303-309) | Yes | LLM-generated phrase, known probability model, Q6 provides the prompt |
| "result.audio.segments expose per-speaker AudioSegment objects" (L382-385) | Yes | Each segment has speaker/start/end/audio/transcript — all derivable from timeline |
| "Capability matrix is rendered into adapter docs" (L609-614) | Marginally | Tagged @unit but tests documentation content — implementer must choose what "docs" means: module docstring, a `.md` file, or generated docs. AC is vague on this. Low-risk: implementer can pick any of these and pass the AC. |

---

## Summary

**New findings count:** 0 high / 3 medium / 1 low

**Launch verdict: NEEDS ONE MORE FIX**

**Minimum changes required before launch:**

1. `specs/voice-agents.feature` L559: Extend hard-deps `Then` clause from 4 deps to all 9 (5 minutes to fix).
2. `specs/voice-agents.feature` L634: Relax "warning points to docs" to "warning references accuracy differences" OR update delivery-plan warning text to include a docs pointer (choose one).
3. `docs/proposals/issue-350-delivery-plan.md` L82, L143 and `specs/voice-agents.feature` L650: Clarify ffplay vs ffmpeg — either say "system ffplay (graceful no-op if absent)" or "ffmpeg with audio output driver." Do not say "using the bundled ffmpeg binary path" for ffplay since ffplay is not in imageio-ffmpeg's bundle.

Finding #4 (openai in Background) is low-severity and can be fixed or accepted as-is without blocking launch.

**Residual risk after fixes:** The ElevenLabs WebSocket URL (`wss://api.elevenlabs.io/v1/convai/conversation`) and the "Capability matrix is rendered into adapter docs" scenario are both somewhat vague but are implementer-level calls that Q5/the delivery plan leaves deliberately open — acceptable for a ralph-style loop.
