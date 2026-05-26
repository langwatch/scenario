# Voice Consolidation Map — branch `voice/372-consolidation`

**Branch:** `voice/372-consolidation`
**Base:** `origin/docs/372-voice-internal-design` (commit `aa951bc` = `main c8cca4e` + EDR docs)
**Date:** 2026-05-26

---

## Merge Summary (all 10 siblings in order)

| # | PR | Branch | Status | Conflicted Files |
|---|----|---------|---------|----|
| 1 | #513 | `ts-voice-tts-stt-plumbing` | **clean** | (none) |
| 2 | #515 | `ts-voice-adapter-runtime` | **conflicted** | `voice/index.ts` |
| 3 | #528 | `ts-voice-simulator-judge-messages` | **conflicted** | `voice/index.ts` |
| 4 | #538 | `ts-voice-script-steps-result` | clean (auto-merged) | `voice/index.ts` auto-resolved; `voice/adapter.ts` auto-resolved |
| 5 | #537 | `ts-voice-effects` | **conflicted** | `voice/index.ts`, `package.json`, `pnpm-lock.yaml` |
| 6 | #536 | `ts-voice-elevenlabs-adapter` | **conflicted** | `voice/index.ts`, `package.json`, `pnpm-lock.yaml` |
| 7 | #535 | `ts-voice-openai-realtime-adapter` | **conflicted** | `package.json`, `pnpm-lock.yaml` |
| 8 | #534 | `ts-voice-gemini-live-adapter` | **conflicted** | `pnpm-lock.yaml` |
| 9 | #540 | `ts-voice-pipecat-g711` | **conflicted** | `voice/index.ts`, `package.json`, `pnpm-lock.yaml` |
| 10 | #539 | `ts-voice-twilio` | **conflicted** | `voice/adapters/twilio-shared.ts`, `voice/__tests__/voice-contract-surface.test.ts`, `specs/voice-agents.feature`, `pnpm-lock.yaml` |

---

## Conflict Table (one row per conflict site)

| File | Sibling Branches Involved | EDR Gap # | Resolution | Note |
|------|--------------------------|-----------|------------|------|
| `javascript/src/voice/index.ts` | All 10 (each diverges) | Barrel — no numbered gap | inline-keep-both (SALVAGE-CONFLICT comment per hunk) | 6 distinct conflict hunks resolved across merges 2–5, 6, 9; incoming exports appended to existing barrel each time |
| `javascript/src/voice/adapters/twilio-shared.ts` | #540 (pipecat, codec-only) vs #539 (twilio, codec+REST+validation) | Gap #6 | inline-keep-both | 11 conflict hunks; pr-540 uses fn names `mulaw8kToPcm16At24k`/`pcm16At24kToMulaw8k`; pr-539 uses `mulaw8kToPcm16_24k`/`pcm16_24kToMulaw8k`; pr-539 also adds `TwilioRESTHelper`, `validateE164`, `validateDtmf`, `redactE164`, `escapeXmlAttr`, `verifyTwilioSignature` — all retained |
| `javascript/src/voice/__tests__/voice-contract-surface.test.ts` | #540 vs #539 | Gap #? | inline-keep-both | Tag filter divergence: `{includeTags:["ts-bound"]}` with excludes (HEAD) vs `{includeTags:[["ts-bound","ts-contract-surface"]]}` (incoming) |
| `specs/voice-agents.feature` | #540 vs #539 | Gap #? | inline-keep-both | PR11 adds Twilio-specific scenarios (`@ts-twilio-proto`, `@ts-twilio-server`); both sets retained |
| `javascript/package.json` | Multiple: #537 vs #536 (fft.js vs elevenlabs dep), #535/#540/#539 (ws version range) | Gap #? | inline-keep-both | `fft.js: 4.0.4` (effects) and `elevenlabs: ^1.59.0` (ElevenLabs) both retained; ws pinning vs range kept as range `^8.20.1`; duplicate `@types/ws` from #539 auto-merge deduplicated |
| `javascript/pnpm-lock.yaml` | Multiple merges | Gap #? | inline-keep-both (markers stripped) | Generated lockfile — conflict markers removed keeping both specifier/package sets; not semantically valid but preserves all info |
| `javascript/src/voice/index.ts` — AgentSpeakingEvent | #538 (from `./adapter`) vs #515 (from `./adapter.runtime`) | Gap #4 | inline-keep-both (both export blocks retained; comment labels site) | Duplicate symbol at top-level barrel; reconcile in refactor |
| `javascript/src/voice/adapters/composable.ts` — STTProvider/synthesize | #536 (inline copies) vs #513 (canonical `stt.ts`/`tts.ts`) | Gap #5 | inline-keep-both at sub-barrel level | `composable.ts` retains its own `ElevenLabsSTTProvider` and `synthesize`; top-level barrel exports canonical `./stt` version; divergent copies remain in `./adapters/composable` |
| `javascript/src/voice/messages.ts` — createAudioMessage format | #528 (WAV builder) vs implicit #515 (PCM16 in adapter.runtime) | Gap #3 | inline-keep-both | `messages.ts` emits WAV+`format:"wav"`; `adapter.runtime.ts` emits raw PCM16+`format:"pcm16"`; LIVE BUG as described in §7.8 — both retained, must be reconciled before first integration test |

---

## SALVAGE-CONFLICT Marker List (grep)

Sites in `javascript/src/` and `specs/`:

```
javascript/src/voice/__tests__/voice-contract-surface.test.ts:290  [EDR Gap #?] pipecat vs twilio tag filter
javascript/src/voice/__tests__/voice-contract-surface.test.ts:297  [EDR Gap #?] incoming twilio tag filter
javascript/src/voice/adapters/twilio-shared.ts:2    [EDR Gap #6] pipecat vs twilio — header docstring
javascript/src/voice/adapters/twilio-shared.ts:23   [EDR Gap #6] incoming twilio side
javascript/src/voice/adapters/twilio-shared.ts:42   [EDR Gap #6] pipecat vs twilio — constants + BIAS/CLIP
javascript/src/voice/adapters/twilio-shared.ts:77   [EDR Gap #6] incoming twilio side
javascript/src/voice/adapters/twilio-shared.ts:127  [EDR Gap #6] pipecat vs twilio — encode sample fn
javascript/src/voice/adapters/twilio-shared.ts:201  [EDR Gap #6] incoming twilio side (pcmSampleToMulaw)
javascript/src/voice/adapters/twilio-shared.ts:235  [EDR Gap #6] pipecat vs twilio — decode sample fn
javascript/src/voice/adapters/twilio-shared.ts:259  [EDR Gap #6] incoming twilio side (mulawByteToPcmSample)
javascript/src/voice/adapters/twilio-shared.ts:280  [EDR Gap #6] pipecat vs twilio — mulaw↔pcm composite fns
javascript/src/voice/adapters/twilio-shared.ts:303  [EDR Gap #6] incoming twilio side (mulaw8kToPcm16_24k)
javascript/src/voice/adapters/twilio-shared.ts:337  [EDR Gap #6] pipecat vs twilio — iterMulawFrames
javascript/src/voice/adapters/twilio-shared.ts:354  [EDR Gap #6] incoming twilio side
javascript/src/voice/adapters/twilio-shared.ts:400  [EDR Gap #6] pipecat vs twilio — MediaStreamEvent interface
javascript/src/voice/adapters/twilio-shared.ts:406  [EDR Gap #6] incoming twilio side (MediaStreamEventName + KNOWN_EVENTS)
javascript/src/voice/adapters/twilio-shared.ts:420  [EDR Gap #6] pipecat vs twilio — parseMediaStreamFrame (streamSid extraction)
javascript/src/voice/adapters/twilio-shared.ts:428  [EDR Gap #6] incoming twilio side
javascript/src/voice/adapters/twilio-shared.ts:452  [EDR Gap #6] pipecat vs twilio — parseMediaStreamFrame (media event)
javascript/src/voice/adapters/twilio-shared.ts:466  [EDR Gap #6] incoming twilio side
javascript/src/voice/adapters/twilio-shared.ts:485  [EDR Gap #6] pipecat vs twilio — parseMediaStreamFrame (mark + stop/connected/start)
javascript/src/voice/adapters/twilio-shared.ts:489  [EDR Gap #6] incoming twilio side
javascript/src/voice/adapters/twilio-shared.ts:499  [EDR Gap #6] pipecat vs twilio — buildClearFrame docstring
javascript/src/voice/adapters/twilio-shared.ts:509  [EDR Gap #6] incoming twilio side (REST helpers section starts)
javascript/src/voice/index.ts:24   [EDR Gap #4] AgentSpeakingEvent: ./adapter vs ./adapter.runtime duplicate
javascript/src/voice/index.ts:97   [EDR Gap #?] tts exports: pipecat vs adapter-runtime
javascript/src/voice/index.ts:108  [EDR Gap #5] ElevenLabsSTTProvider: stt.ts vs adapters/composable
javascript/src/voice/index.ts:143  [EDR Gap #3] messages: WAV (messages.ts) vs PCM16 (adapter.runtime.ts)
javascript/src/voice/index.ts:150  [EDR Gap #?] effects barrel export appended
javascript/src/voice/index.ts:153  [EDR Gap #5] adapters STTProvider/synthesize divergent copies
javascript/src/voice/index.ts:168  [EDR Gap #6] pipecat adapter + pending-transport-error
specs/voice-agents.feature:93      [EDR Gap #?] pipecat vs twilio scenario sets
```

Total SALVAGE-CONFLICT sites: **33** (24 in `twilio-shared.ts`, 7 in `voice/index.ts`, 1 in `voice-contract-surface.test.ts`, 1 in `specs/voice-agents.feature`)

---

## Total File Count Under `javascript/src/voice/`

- **TypeScript files (`.ts`):** 56
- **All files (including `.wav`, `.md`):** 62
- **Sub-directories:** `__tests__/`, `adapters/` (with `__tests__/`), `assets/noise/`, `effects/` (with `__tests__/`)

---

## Surprises vs EDR Predicted Collisions

### Predicted collisions that materialized:
- `voice/index.ts` — YES, every merge (all 10 siblings diverge)
- `voice/adapters/twilio-shared.ts` — YES, Gap #6 fully materialized (2 divergent files at same path, codec fn naming + REST additions)
- `voice/adapters/composable.ts` — YES, Gap #5 (divergent STTProvider/synthesize copies)
- `voice/messages.ts` + `voice/adapter.runtime.ts` format split — YES, Gap #3 (WAV vs PCM16 in-message format)
- `package.json` / `pnpm-lock.yaml` — YES (dependency additions from multiple PRs)

### Predicted collisions NOT observed as git conflicts (auto-resolved or not present):
- `voice/adapter.ts` — EDR predicted "3-way fork" (Gap #4); git auto-merged `adapter.ts` in merges 2 and 4 without conflict markers. The content from all three variants appears to be present but git resolved it silently. **Verify in review** that `sendDtmf` and `AgentSpeakingEvent` from pr-538 are present alongside the default `call()` from pr-515.
- `voice/voice-executor-state.ts` — EDR predicted "2-fork"; auto-merged without conflict in merge 4 (#538). Both the `interruptions` and `backgroundNoise` fields from pr-538 should be present.
- `voice/voice-models.ts` — EDR predicted "2-fork"; auto-merged without conflict in merge 6 (#536). ElevenLabs + composable model constants should be present.
- `domain/scenarios/index.ts` — auto-merged cleanly across merges.
- `execution/scenario-execution.ts` + `scenario-execution-state.ts` — auto-merged cleanly.
- `agents/judge/judge-agent.ts` + `user-simulator-agent.ts` — auto-merged cleanly.

### Unpredicted conflicts:
- `specs/voice-agents.feature` — conflicted on merge 10 (#539 vs #540). The EDR did not flag this as a predicted conflict; it's a real flat-sibling divergence (PR10 and PR11 both added new scenarios to the same place in the feature file).
- `voice/__tests__/voice-contract-surface.test.ts` — conflicted on merge 10 with tag filter divergence. Not predicted.
- `package.json` duplicate `@types/ws` — PR11's auto-merge of `package.json` inserted a second `@types/ws: ^8.18.0` entry; deduplicated manually.
