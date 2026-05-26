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
| #7  | `voice/config.ts` — per-run `VoiceConfig`/`SttConfig`/`TtsConfig` + `resolveVoiceConfig` (keystone) | A | ✅ DONE (ee4ddaf) |
| #1  | split `stt.ts` → `stt/` (interface+router, openai, elevenlabs, index); drop global + setSttProvider/getSttProvider | A | ✅ DONE (a7a6e72) |
| #2  | delete invented `configure({stt})`; keep `configure()` for global exec (audioPlayback) | A | ✅ DONE (0b22e0c) |
| #3  | unify the TWO `createAudioMessage` producers → ONE AI-SDK `file`-part encoder + ONE extractor (LIVE BUG) | A | ✅ DONE (93d6c42) |
| #4  | merge 3-way `adapter.ts` (call + sendDtmf + AgentSpeakingEvent) | A-verify | ✅ VERIFIED intact (silent merge kept union); barrel dup resolved (acf77c7) |
| #5  | de-dupe `adapters/composable.ts` STTProvider/synthesize copies → import canonical | B | DEFER — Tier A removed the stt global it must now import; composable still holds its own copies |
| #11 | settle abstract-vs-default `call()` across leaves | B/C | DEFER |
| #6  | reconcile 2 divergent `twilio-shared.ts` (codec fn names + REST) | B | DEFER (22 markers — blocks 18 test files transitively) |
| #8  | interruption executor verbs (`voiceProceed`/`backgroundNoise`) | C | DEFER (fields present in voice-executor-state; verbs unimplemented) |
| #9  | site the 5 script steps in `voice/steps.ts` (§7.1a DECIDED) | C | DEFER |
| #10 | `tts/elevenlabs-tts.ts` leaf (§7.1b DECIDED) | B/C | DEFER |

Host wiring (Tier A): ✅ DONE (e59287e) — `ScenarioConfig.voice?` field + `RunOptions.voice` + `runner/run.ts` boundary seed + per-run `resolveVoiceConfig` in the executor (which IS the VoiceExecutorState). `voice-executor-state.ts` (pr-538 interruption fields) and `voice-models.ts` (pr-536 EL/composable constants) were already auto-merged intact — only added an additive `voiceConfig?` field to the former.

Also fixed (blockers, not gaps): invalid-JSON SALVAGE comment in package.json + regen lockfile (5260b2a); duplicate `"target"` key in tsconfig.json that broke vitest's oxc loader (173e78c).

## Final state (Tier A)

**Typecheck (`npx tsc --noEmit`):** real tree = 5 errors, ALL `twilio-shared.ts` syntax (Gap #6 keep-both merge; its PARSE error masks full-program checking). With twilio-shared stubbed parse-only, full tsc = 61 errors, of which **58 are twilio/pipecat (Tier B) + stub artifacts**, and **3 are pre-existing vitest `Mock<>`→typed-fn nits** (transcribe.test.ts:70, tts.test.ts:48, user-simulator-voice.test.ts:70 — identical to pre-Tier-A; masked at baseline by the same twilio parse error). **My Tier A changes introduce ZERO new type errors.**

**Unit tests:**
- Tier A gate (config/stt/transcribe/messages + recording/result/interruption/judge-voice): **8 files, 110 tests, all pass.**
- Full suite real tree: 329 passed / 18 files failed — all 18 are the twilio-shared parse cascade.
- Full suite with twilio-shared stubbed (parse-only): **38 of 45 files pass**; the 6 remaining failures (28 tests) are 100% Twilio/Pipecat codec-behavior (g711 round-trip, µ-law, validateE164/DTMF, Media Streams parse, clear-buffer) — pure Tier B (Gap #6). This proves runner/run, scenario-execution, red-team, effects, voice-steps, hooks, adapter-lifecycle, vad-fallback all pass with the host wiring + format change.

**SALVAGE-CONFLICT markers:** 33 → **29 remaining** (resolved 4: Gap #4 AgentSpeakingEvent, Gap #1 stt, Gap #3 messages, +1 tts marker). Remaining: twilio-shared.ts (22, Gap #6), voice/index.ts (4 — tts/effects/composable-#5/pipecat-#6, all Tier B), voice-contract-surface.test.ts (2, Tier B tags), specs/voice-agents.feature (1, Tier B scenarios).

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

1. **Gap #6 (twilio-shared.ts) is the critical-path blocker.** Its keep-both merge fused two
   function bodies (`resamplePcm16`'s signature followed by a fragment of `pcmSampleToMulaw`'s
   body at line ~200), producing a TS1xxx PARSE error. Because it fails to parse, oxc cannot
   transform any file that transitively imports the voice barrel → **18 test files fail to even
   load** (and tsc full-program checking is masked). Tier B must reconcile it FIRST. Divergence
   to resolve: codec fn names (`mulaw8kToPcm16At24k`/`pcm16At24kToMulaw8k` for pipecat vs
   `mulaw8kToPcm16_24k`/`pcm16_24kToMulaw8k` for twilio) + pr-539's REST helpers
   (`TwilioRESTHelper` with `resolvePhoneNumberSid`/`placeCall`/`readVoiceUrl`/`writeVoiceUrl`/
   `sendDtmfOnCall`) + validation (`validateE164`/`validateDtmf`/`verifyTwilioSignature`/
   `escapeXmlAttr`/`redactE164`) + constants `TWILIO_FRAME_BYTES`/`TWILIO_SAMPLE_RATE` + the
   real `parseMediaStreamFrame` return type (with `.event`/`.streamSid`/`.payloadMulaw`/`.dtmfDigit`).

2. **Gap #5 (composable.ts) now MUST move** — Tier A deleted the stt module-global and the
   `setSttProvider`/`getSttProvider` exports. `adapters/composable.ts` still defines its own
   divergent `STTProvider`/`ElevenLabsSTTProvider`/`synthesize` copies; Tier B should repoint it
   to import the canonical `./stt` interface + `./tts` synthesize. (composable.ts did NOT error
   in Tier A because it self-contains its copies — but the EDR mandates de-dup.)

3. **Gap #3 ripple — the canonical `file` format.** Tier A made `messages.ts` the sole producer of
   AI-SDK `file` parts and taught `JudgeAgent.conversationHasAudio` to detect them. Tier B/C
   adapter leaves (openai-realtime already emits `file`; gemini/elevenlabs/pipecat/twilio emit
   raw PCM16 or native shapes) should convert native↔`file` at the adapter EDGE only, and the
   simulator (user-simulator-agent.ts) + judge-stt pre-pass should consume the shared extractor.

4. **Gap #11** — leaf `call()` reconciliation (realtime throws, gemini returns "") — B/C, after
   the adapter.ts base is settled (already merged; just needs the leaves to agree).

5. **Gap #8 / #9 / #10** (interruption verbs, steps.ts, elevenlabs-tts leaf) — Tier C, unchanged
   by Tier A. `voice-executor-state.ts` already carries the pr-538 `voiceInterruptions`/
   `voiceBackgroundNoise` fields; the consuming verbs are still unimplemented.

6. **VoiceExecutorState class-form (EDR §0.1 target).** The EDR's eventual `class
   VoiceExecutorState { ctor(ResolvedVoiceConfig); connectAll/disconnectAll }` is a bigger
   executor refactor. As-built, `ScenarioExecution` *implements* the `VoiceExecutorState`
   *interface* and owns connect/disconnect. Tier A added the resolved-config field
   (`voiceConfig: ResolvedVoiceConfig | null`) to it rather than introducing the parallel class.
   Promoting to the standalone class is B/C if desired.

7. **Pre-existing vitest Mock-typing nits** (transcribe.test.ts:70, tts.test.ts:48,
   user-simulator-voice.test.ts:70) — `vi.fn()` mocks not assignable to typed fn signatures
   under vitest 4 strictness. Tests pass at runtime (oxc strips types). Pre-existing; left as-is
   to avoid scope creep. A future sweep could add `satisfies`/explicit-typing.

## Deviations from the EDR (intentional, noted for review)
- **Interface name kept `STTProvider`** (existing casing) rather than the EDR §0.1 aspirational
  `SttProvider`. Renaming would churn every consumer (transcribe, composable, tests, the barrel)
  for zero behavioral gain — deferred as gold-plating. The richer `transcribe(audio, {model,
  language?, apiKey?})` signature in §0.1 was also NOT adopted — all consumers use the as-built
  `transcribe(audio): Promise<string>`; the model/language/apiKey live on `SttConfig`/the
  provider constructor instead, which is where they actually resolve.
- **`AudioFormat` is a string union** (`"pcm16"|"wav"|"mulaw"`) not the EDR's
  `{encoding;sampleRate;channels}` record — nothing in the core consumes the richer shape
  (`AudioChunk` fixes 24 kHz mono); the in-message tag is what matters.
</content>
</invoke>
