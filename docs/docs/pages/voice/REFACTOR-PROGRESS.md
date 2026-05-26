# Voice #372 Refactor — Progress Tracker

**Branch:** `voice/372-refactor` (based off `voice/372-consolidation`).
**Spec:** `docs/voice/internal-design.md` (EDR), `docs/adr/002-voice-provider-state.md`, `docs/voice/CONSOLIDATION-MAP.md`.

Tiering (orchestrator's split):
- **Tier A** — foundation: config.ts (per-run state), stt/ split, configure de-invention, one audio format (Gap #3 live bug), host wiring for voice config + per-run state, barrel cleanup for those modules.
- **Tier B** — adapter merges, twilio-shared reconciliation, tts/ split.
- **Tier C** — steps.ts, judge-stt, interruption verbs, simulator/judge edits.

---

## Baseline (captured before Tier A work)

`pnpm install` (after fixing invalid-JSON SALVAGE comment in package.json) → 680 pkgs, exit 0.
`npx tsc --noEmit` → **5 errors, ALL in `src/voice/adapters/twilio-shared.ts`** (keep-both merge fused two function bodies; Gap #6 / Tier B). The rest of the voice core typechecks clean at baseline.

Commands (reproduce validation):
```
cd javascript
pnpm install
npx tsc --noEmit
npx vitest run src/voice/__tests__ src/config/__tests__
```

---

## Gap checklist (the 11 numbered EDR gaps)

| Gap | What | Tier | Status |
|-----|------|------|--------|
| #7  | `voice/config.ts` — per-run `VoiceConfig`/`SttConfig`/`TtsConfig` + `resolveVoiceConfig` (keystone) | A | TODO |
| #1  | split `stt.ts` → `stt/` (interface+router, openai, elevenlabs, index); drop global + setSttProvider/getSttProvider | A | TODO |
| #2  | delete invented `configure({stt})`; keep `configure()` for global exec (audio_playback) | A | TODO |
| #3  | unify the TWO `createAudioMessage` producers → ONE AI-SDK `file`-part encoder + ONE extractor (LIVE BUG) | A | TODO |
| #5  | de-dupe `adapters/composable.ts` STTProvider/synthesize copies → import canonical | B (Tier A removes the stt global it depends on) | DEFER |
| #4  | merge 3-way `adapter.ts` (call + sendDtmf + AgentSpeakingEvent) | A-verify / B | VERIFIED intact (silent merge kept union) |
| #11 | settle abstract-vs-default `call()` across leaves | B/C | DEFER |
| #6  | reconcile 2 divergent `twilio-shared.ts` (codec fn names + REST) | B | DEFER (24 markers) |
| #8  | interruption executor verbs (`voiceProceed`/`backgroundNoise`) | C | DEFER |
| #9  | site the 5 script steps in `voice/steps.ts` (§7.1a DECIDED) | C | DEFER |
| #10 | `tts/elevenlabs-tts.ts` leaf (§7.1b DECIDED) | B/C | DEFER |

Host wiring (Tier A): `ScenarioConfig.voice?` field + `runner/run.ts` resolution + per-run `VoiceExecutorState`; reconcile `voice-executor-state.ts` (keep pr-538 fields) + `voice-models.ts` (keep pr-536 constants).

---

## Findings

### Task 0 — adapter.ts silent 3-way merge: VERIFIED INTACT
`git diff` against `origin/issue372/ts-voice-adapter-runtime` (#515) and `origin/issue372/ts-voice-script-steps-result` (#538) confirms the union:
- concrete `call()` delegating to `defaultVoiceCall` (adapter.ts:67) — from #515
- `sendDtmf` (adapter.ts:122), `AgentSpeakingEvent` interface (adapter.ts:28), `streamingTranscript`/`agentSpeakingEvent` fields — from #538
Nothing dropped. No restoration needed.

### voice-executor-state.ts / voice-models.ts forks
Both auto-merged clean and already carry the kept-fork content:
- `voice-executor-state.ts` (an **interface**, not the EDR's eventual class) already has pr-538's `voiceInterruptions` + `voiceBackgroundNoise` fields.
- `voice-models.ts` already has pr-536's `ELEVENLABS_TTS_MODEL=eleven_v3`, `ELEVENLABS_STT_MODEL=scribe_v1`, `ELEVENLABS_DEFAULT_VOICE_ID`, `COMPOSABLE_VOICE_LLM_MODEL=gpt-5.4-mini`.

### Gap #3 — the live bug (confirmed by code)
Two producers, both emit OpenAI-convention `input_audio` (a shape the judge's `buildTranscriptFromMessages` does NOT even recognize):
- `messages.ts#createAudioMessage` → WAV-wrapped, `format:"wav"`; its `extractAudio` strips RIFF.
- `adapter.runtime.ts#createAudioMessage` (private) → raw PCM16, `format:"pcm16"`; its `extractAudioFromLastMessage` reads base64 raw.
Canonical target (EDR §4.2, already spoken by `realtime/response-formatter.ts:22` and consumed by `judge-utils.ts:34`): `{ type: "file", mediaType: "audio/pcm16", data: <base64> }` + transcript as a sibling `{type:"text"}` part.

---

## Cascades to Tier B/C
- Gap #5 (composable.ts dup STTProvider/synthesize) — once Tier A removes the stt global and lands `stt/`, composable.ts must import the canonical interface. Composable still defines its own copies (Tier B).
- Gap #6 — twilio-shared.ts (5 tsc errors) left for Tier B.
- Gap #11 — leaf `call()` reconciliation (realtime throws, gemini returns "") left for B/C.
- The EDR class-form `VoiceExecutorState` (with connectAll/disconnectAll, ctor(ResolvedVoiceConfig)) is a bigger executor change — Tier A keeps the existing interface + threads ResolvedVoiceConfig where the runner constructs per-run state. Full class is B/C.
</content>
</invoke>
