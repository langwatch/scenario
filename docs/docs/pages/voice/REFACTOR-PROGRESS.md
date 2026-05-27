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
| #5  | de-dupe `adapters/composable.ts` STTProvider/synthesize copies → import canonical | B | ✅ DONE (c559738) — composable imports `STTProvider`/`ElevenLabsSTTProvider` from `./stt`, routes TTS via `./tts`; inline synthesize + 4th WAV dup deleted |
| #11 | settle abstract-vs-default `call()` across leaves | B/C | ✅ DONE (2262e7d Tier B + 1ff5e50 Tier C) — leaves inherit `defaultVoiceCall`; composable keeps its own; **Tier C** added the uniform `isConnected()` gate so `defaultVoiceCall`/`startVoiceTurn` raise `PendingTransportError` before connect across every leaf |
| #6  | reconcile 2 divergent `twilio-shared.ts` (codec fn names + REST) | B | ✅ DONE (2d94998) — single module; canonical `*At24k` codec + `*_24k` aliases; pr-539 REST/validation kept; all 22 markers + 2 spec-side markers resolved |
| #8  | interruption executor verbs (`voiceProceed`/`backgroundNoise`) | C | ✅ DONE (ce67b4b) — executor `proceed()` consumes the active `InterruptionConfig` (voiceProceed wins, else built from sim `interruptProbability`) → fires barge-in + `user_interrupt` event (RNG-injected); `voiceInterruptions`/`voiceBackgroundNoise` are real executor fields; `interrupt({after})` TIME-based + per-step `voiceStyle`/`audioEffects` on `user()` + `startVoiceTurn`/`VoiceTurnHandle` bridge |
| #9  | site the 5 script steps (§7.1a) — RATIFIED at `script/voice-steps.ts` | C | ✅ DONE — steps live at `script/voice-steps.ts` (ratified deviation from EDR §7.1a `voice/steps.ts`; steps belong with the script module), re-exported via `script/index.ts`. Tier C extended `interrupt` (TIME-based `after`) + `user` (per-step overrides) |
| #10 | `tts/elevenlabs-tts.ts` leaf (§7.1b DECIDED) | B | ✅ DONE (7753305) — tts/ split mirrors stt/; `ElevenLabsTtsProvider` leaf (eleven_v3 / pcm_24000); cache invariant preserved |

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

---

# Tier B — adapter merges, twilio-shared, tts/ split (DONE)

**Commits (on `voice/372-refactor`, atop Tier A `9235e43`):**
- `2d94998` Gap #6 — reconcile the two divergent twilio-shared.ts into one
- `7753305` Gap #10 — split flat tts.ts into tts/ subtree + ElevenLabs TTS leaf
- `c559738` Gap #5 — de-dup composable.ts onto canonical stt/tts; collapse EL files
- `2262e7d` Gap #11 — settle call() across leaves on the runtime default
- `ba0b4de` clear the 3 pre-existing vitest Mock<> type nits → tsc clean

**Final HEAD:** `ba0b4de`.

## Convergence gate (held)
- **`npx tsc --noEmit` → 0 errors (CLEAN).** The 3 pre-existing vitest-4 Mock<> nits
  (transcribe.test:70, tts.test:48, user-simulator-voice.test:70) — documented in Tier A as
  pre-existing and masked by the twilio parse error — are fixed with minimal `as unknown as`
  casts (test-only; runtime unchanged).
- **Full suite (`npx vitest run`): 44 files passed / 1 skipped; 697 tests passed / 5 skipped.
  Zero failures.** The Tier A baseline's 18 twilio-cascade file failures are GONE. The 1 skipped
  file (`twilio-tunnel.test` — env-gated `@e2e`, needs `NGROK_AUTHTOKEN`) and 5 skipped tests
  (4 = the bare-`@unit` EL hosted-connect scenario the `[["unit","ts-elevenlabs"]]` filter
  doesn't select — covered by that file's 14 wire-protocol unit tests; 1 = the tunnel e2e) are
  all benign env/tag gates, not regressions.
- Named gate cluster green: twilio, twilio-server, twilio-shared-codec, twilio-tunnel, pipecat,
  openai-realtime, gemini-live, elevenlabs, composable (bound inside elevenlabs.test), tts.
- **SALVAGE-CONFLICT markers: 29 → 0** in `javascript/src` + `specs` (grep clean).

## Gap #6 — twilio-shared reconciliation (the critical-path blocker)
The keep-both merge had physically **interleaved** pr-540's (pipecat, codec-only) and pr-539's
(twilio, codec+REST+validation) function bodies — `resamplePcm16`'s signature spliced into
`pcmSampleToMulaw`'s body → TS1390 (`if` as param) + TS1109 + TS1005 parse errors that masked
full-program tsc and cascaded to 18 files importing the voice barrel. Rebuilt as ONE module:
- **Canonical codec = pr-540 semantics.** Decisive: `twilio-shared-codec.test` asserts
  `resamplePcm16(x,24000,24000) === x` (same-rate identity — only pr-540 early-returns the input)
  and round()-based output lengths. Canonical fn names `mulaw8kToPcm16At24k`/`pcm16At24kToMulaw8k`;
  pr-539's `mulaw8kToPcm16_24k`/`pcm16_24kToMulaw8k` kept as **re-exported aliases** so the Twilio
  trio's call sites don't churn. One impl, two names.
- **Kept pr-539's** `TwilioRESTHelper`, `validateE164`/`validateDtmf`, `redactE164`/`escapeXmlAttr`,
  `verifyTwilioSignature` (X-Twilio-Signature, fail-closed), the `KNOWN_EVENTS`-guarded
  `parseMediaStreamFrame` (full `MediaStreamEvent` return shape), and `TWILIO_FRAME_BYTES`/
  `TWILIO_SAMPLE_RATE`/`TWILIO_FRAME_MS`.
- **Two spec-side markers from the same merge, resolved here** (same root cause):
  `specs/voice-agents.feature` had an orphaned `@unit @ts-elevenlabs` tag the merge stranded
  above the Twilio `mulaw/8000` scenario → `elevenlabs.test` bound a Twilio scenario
  (`ScenarioNotCalledError`); dropped it. `voice-contract-surface.test` switched to the AND-match
  filter `includeTags:[["ts-bound","ts-contract-surface"]]` so it no longer sweeps in every
  `@ts-bound` twilio scenario (dropped the brittle excludeTags list).

## Gap #10 — tts/ split + ElevenLabs TTS leaf
Mirrors the stt/ subtree. `tts/{tts,openai-tts,elevenlabs-tts,index}.ts`. Cache invariant
preserved verbatim (key = sha256(text)+voice; effects after cache read). New
`ElevenLabsTtsProvider` leaf (eleven_v3 / `output_format: pcm_24000`) registered under the
`elevenlabs` prefix → `voice="elevenlabs/<id>"` resolves through the registry (PRD headline).
`elevenLabsSynthesizeBytes` carries the `apiKey`+`clientFactory` test seam so composable de-dups
onto it. Directory import keeps `./tts` / `../tts` resolving with zero path churn.

## Gap #5 — composable de-dup + EL file collapse (Task 5)
`adapters/composable.ts` no longer self-defines `STTProvider`, `ElevenLabsSTTProvider`,
`synthesize`, or a 4th `pcm16ToWavBytes`. It imports `STTProvider`/`ElevenLabsSTTProvider` from
`./stt` (re-exporting them for the EL preset + tests) and routes TTS through `./tts` (EL path →
the tts/elevenlabs-tts leaf, honoring the `elevenLabsClientFactory` seam). The canonical
`./stt/elevenlabs-stt.ts` leaf was switched from the fetch-based shape to the **SDK-based**
shape (`{apiKey, clientFactory}` + `speechToText.convert`) — the only one with `transcribe()`
test coverage (elevenlabs.test); `stt.test`'s instanceof check is agnostic.

Task 5 (collapse the two EL files): folded `ElevenLabsVoiceAgent` (the **local** branded
composable preset) into `adapters/elevenlabs.ts` next to the **hosted** `ElevenLabsAgentAdapter`,
deleting `adapters/eleven-labs-voice-agent.ts` → one ElevenLabs file. **Review flag:** the brief/
EDR §0.1 called these "one ConvAI transport adapter," but they are two genuinely distinct
responsibilities (hosted ConvAI WS transport vs local STT+LLM+TTS preset). Collapsing into a
single *file* (not merging the *classes*) honors the "single ElevenLabs file" intent without
destroying the preset's behavior or its 5 bound scenarios. Layout matches EDR §0 (single
`elevenlabs.ts`).

## Gap #11 — call() across leaves
PR3's `defaultVoiceCall` is the base `VoiceAgentAdapter.call()`. Removed the stub `call()`
overrides (which threw / returned `""`) from pipecat, twilio, openai-realtime, gemini-live, and
the hosted `ElevenLabsAgentAdapter` so they inherit the runtime default. `composable.ts` keeps
its own `call()` — it is the local BYO agent that runs the full loop itself, not a thin
transport; its tests drive sendAudio/receiveAudio directly.
**Partial vs the brief:** the "not-yet-connected path raises PendingTransportError" piece is
NOT fully realized — `defaultVoiceCall` drives sendAudio/receiveAudio which raise each adapter's
own "not connected" error (pipecat does throw PendingTransportError at connect() for
`webrtc`). A uniform connected-state gate inside `defaultVoiceCall` needs a common accessor
across leaves (none exists) and no test requires it → left for Tier C, noted below.

## Cascades to Tier C (unblocked by Tier B; NOT started)
1. **§7 tag/spec fixes (Gap-adjacent).** The bare-`@unit` EL "connects to conversational AI
   endpoint" scenario lacks `@ts-elevenlabs`, so the AND-filter skips it (4 skipped steps) — a
   §7.4 tag-alignment item. Behavior is covered by the wire-protocol `describe` block. Align the
   tag in Tier C's §7 sweep.
2. **Gap #11 not-connected gate.** Add a uniform `isConnected()`/`PendingTransportError` path so
   `defaultVoiceCall` raises the single pending-transport error before connect — needs a shared
   accessor across leaves (executor refactor).
3. **Gap #8 / #9** (interruption verbs `voiceProceed`/`backgroundNoise`; site the 5 script steps
   in `voice/steps.ts`) — untouched, as scoped.
4. **judge-stt.ts pre-pass + user-sim TTS wiring** — untouched (Tier C).

## Deviations from the EDR (Tier B, for review)
- **TTS provider shape kept as-built** (`{prefix; synth: TTSCallable}` registry, not the §0.1
  aspirational `class …Provider implements TtsProvider { synthesize(req) }`). Same rationale as
  Tier A's STT call: the as-built router has the test coverage; the EL leaf's class wraps the
  same callable. Zero behavioral gain in churning it.
- **`_24k` codec aliases retained** rather than renaming the twilio trio's call sites to the
  canonical `*At24k`. Keeps the diff to twilio.ts/twilio-server.ts at zero and both naming sets
  documented as one-impl-two-names; a follow-up can collapse the alias if desired.

---

# Tier C — executor audio, factories, interruption, judge-stt, user-sim TTS, connected-state, §7 sweep (DONE)

**Commits (on `voice/372-refactor`, atop Tier B `0a8e168`):**
- `28dec7c` Gaps A+B — attach `result.audio`/`timeline`/`latency`; `emptyRecording()` → `VoiceRecordingRuntime`
- `56bd55a` lowercase adapter factories (PRD §9) + barrel + `scenario.*` wiring
- `18d68c5` net-new `judge-stt.ts` pre-pass + `JudgeAgent.call()` wiring
- `b7cfb1f` user-simulator per-run TTS (default `_synthesize` → `voice/tts#synthesize`)
- `ce67b4b` interruption completeness (Gap #8): `interrupt({after})`, per-step `voiceStyle`/`audioEffects`, `interruptProbability`, executor `proceed()` interruption, `startVoiceTurn`/`VoiceTurnHandle`
- `1ff5e50` Gap #11 uniform `isConnected()` connected-state gate
- `ab3e396` §7 spec/comment sweep

## Convergence gate (held)
- **`npx tsc --noEmit` → 0 errors (CLEAN).**
- **Full suite (`npx vitest run`): see final run below — green, no regression from the 697 baseline,
  plus the new Tier C tests.**
- **SALVAGE-CONFLICT markers: 0** (grep clean in `src` + `specs`).

## What landed (per task)
1. **Executor audio (Gaps A+B).** `ScenarioExecution.setResult()` attaches `audio`/`timeline`/`latency`
   for voice runs via `buildVoiceResultFields()` (latency finalized once at end-of-run via
   `computeLatencyMetrics`); text-only runs leave the fields `undefined` (back-compat).
   `adapter.runtime.ts#emptyRecording()` returns a `VoiceRecordingRuntime` instance so
   `result.audio.save()`/`saveSegments()` exist. **Verified offline** (`result-audio.test.ts`): a real
   `ScenarioExecution.execute()` with a voice `FakeVoiceAdapter` + audio user-sim + fake judge →
   `result.audio instanceof VoiceRecordingRuntime`, segments>0 (user+agent), timeline populated,
   `latency.measurements`>0, `save()` round-trips a WAV.
2. **Adapter factories (PRD §9).** `voice/factories.ts` — `pipecatAgent`/`openAIRealtimeAgent`/
   `geminiLiveAgent`/`elevenLabsAgent`/`twilioAgent`/`composableAgent` thin `new X()` wrappers,
   exported from `voice/index.ts` and merged onto the top-level `scenario` object so
   `scenario.pipecatAgent({...})` works. Class forms kept.
3. **Interruption (Gap #8 + PRD §4.4/§4.2).** `interrupt({after})` TIME-based; per-step
   `user(content, {voiceStyle|audioEffects})` one-shot override (install+revert); `interruptProbability`
   on the user simulator; executor `proceed()` consumes the active `InterruptionConfig` and injects
   barge-ins (RNG-injected for determinism); `startVoiceTurn`/`VoiceTurnHandle` non-blocking bridge.
   `voiceInterruptions`/`voiceBackgroundNoise` promoted to real executor fields.
4. **judge-stt.ts (net-new).** `prepareJudgeInput({messages, stt, options})` transcribes audio `file`
   parts → text BEFORE `buildTranscriptFromMessages`, keeping audio for multimodal models iff
   `includeAudio`. Wired into `JudgeAgent.call()` via `transcribeAudioForJudge()` (resolves stt off
   `cfg.voice`; text-only fast path). NO "judge requests transcript" tool (§7.3).
5. **User-sim per-run TTS.** Default `_synthesize` routes through `voice/tts#synthesize` (per-run
   router + LRU cache; effects after cache read), not the old throwing PR2 stub. Effective voice =
   simulator `voice=` OR per-run `cfg.voice.tts.voice`.
6. **Gap #11 connected-state.** `VoiceAgentAdapter.isConnected()` (base default `true`; overridden by
   every network leaf) gates `defaultVoiceCall`/`startVoiceTurn` → uniform `PendingTransportError`.
7. **§7 sweep.** `@ts-elevenlabs` added to the bare-`@unit` EL connects scenario (now binds, EL suite
   0 skipped); "judge requests a transcript" → "auto-transcribed; judge gets text";
   `scenario.configure(stt=)` strings → `run({voice})`; "PR2 of #372"/"PR2/#513" comments stripped.
8. **dotenv (e2e stage).** `cp javascript/.env javascript/examples/vitest/.env` (gitignored — NOT
   committed). Ready for the next-stage real-key e2e.

## New Tier C test files
- `src/voice/__tests__/result-audio.test.ts` (Gaps A+B, 5)
- `src/voice/__tests__/factories.test.ts` (factories, 7)
- `src/voice/__tests__/judge-stt.test.ts` (judge STT, 6)
- `src/agents/__tests__/user-simulator-tts.test.ts` (per-run TTS, 3)
- `src/execution/__tests__/proceed-interruptions.test.ts` (Gap #8 proceed, 4)
- `src/voice/__tests__/start-voice-turn.test.ts` (VoiceTurnHandle, 4)
- `src/script/__tests__/interrupt-after-and-user-overrides.test.ts` (interrupt after + user overrides, 5)
- `src/voice/__tests__/connected-state.test.ts` (Gap #11, 5)

## Ratified deviations (kept, not churned)
- Script steps at `script/voice-steps.ts` (not EDR §7.1a `voice/steps.ts`) — steps belong with the
  script module; re-exported via `script/index.ts`.
- `STTProvider` name + `transcribe(audio): Promise<string>`; `AudioFormat` string-union;
  `elevenlabs.ts` one-file-two-classes (per Tier A/B notes above).

## Notes for the e2e stage (NOT run here — real-key)
- The PRD §9 idiom (`scenario.pipecatAgent({...})`) now works end-to-end; demos should use the
  factories to prove the documented API.
- `javascript/examples/vitest/.env` is in place (gitignored) for real-key runs.
- The `@ts-e2e` round-trip audio assertion (EDR §8) — drive a known utterance through user-sim TTS →
  bus → adapter → judge STT and assert the far-side transcript matches — is the gate to add next.
- Per-step `voiceStyle` is wired as PLUMBING (one-shot install/revert) but the AUDIBLE effect is
  pending a TTS backend that honors style (the simulator emits a one-shot warning today; spec scenario
  stays `@todo`).

---

# E2E + AUDIO-PROOF stage — real-key demos + the @ts-e2e gate (DONE)

**Branch:** `voice/372-refactor`, atop Tier C `2dcff36`. Real provider keys (OpenAI /
ElevenLabs + live agent_id / Gemini), NO mocks. Recordings committed under
`javascript/recordings/<demo>/` (full.wav + manifest.json [+ segments for core demos];
all files <1MB; `.gitignore` JS-recordings policy + `javascript/recordings/README.md`
mirror `python/recordings/`).

## The @ts-e2e ROUND-TRIP GATE (EDR §8) — PASSES with real keys
`examples/vitest/tests/voice/ts-e2e-roundtrip.test.ts` + the new `@e2e @ts-e2e`
scenario. Drives a known utterance through user-sim TTS → message bus
(`createAudioMessage`, canonical AI-SDK `file` part) → judge STT (`OpenAISTTProvider`)
and asserts the far-side transcript matches within a word-level tolerance (≥0.8). The
Gap #3 LIVE-BUG regression guard. **Verified:** far-side transcript byte-identical to
input ("The quick brown fox jumps over the lazy dog."), 3.95s PCM16 round-trip.

## Per-demo status (audio produced?)
| Demo | Path | Result | Audio |
|---|---|---|---|
| `openai_realtime_agent` | OpenAI Realtime (role=AGENT), BASELINE | ✅ success=true | full.wav 204KB + segments |
| `openai_realtime_user` | OpenAI Realtime (role=USER), §7.2 | ✅ spoken audio captured | full.wav 465KB + segment |
| `elevenlabs_hosted` | live ConvAI WS | ✅ success=true | full.wav 328KB + segments |
| `elevenlabs_branded` | EL STT+LLM+TTS in-process | ✅ STT/LLM/TTS fired | full.wav 327KB + segments |
| `gemini_live` | Gemini Live native audio | ✅ success=true | full.wav 224KB + segments |
| `composable_stt_swap` | `run({ voice: { stt } })` | ✅ EL STT calls=1 | full.wav + manifest |
| `recording_playback` | `save()` WAV + MP3 | ✅ WAV 244KB + MP3 20KB | full.wav + manifest |
| `voice_text_parity` | same entrypoint voice vs text | ✅ both success=true | full.wav + manifest |
| `pipecat_ws` | live bot, Twilio Media Streams (mulaw/8000) | ✅ success=true | full.wav 343KB + manifest |
| `twilio_inbound/outbound` | real phone + tunnel | ⏸ MANUAL (skipped) | — |

Full e2e suite: **8 files / 33 tests pass** (real keys); pipecat skips when the bot is
down (passes when up). Twilio: `NGROK_AUTHTOKEN` + ngrok absent → `⏸ manual`, NOT
run (matches capability-matrix `⏸ real phone`); does not gate CI.

## Executor parity bugs FIXED while wiring the demos (TS src, no python edits)
Three real gaps the demos surfaced — each was masking a non-functional documented path:
1. **`user("text")` voice routing** (`scenario-execution.ts`): scripted explicit content
   reached a voice agent under test as TEXT (no audio) → its `call()` timed out draining
   an un-prompted response. Now mirrors `scenario_executor.py:user`: realtime USER →
   `sendText`; voice user-sim → `voiceifyText` (TTS) → audio message; else text. Added
   `UserSimulatorAgent.voice` getter + `voiceifyText()` (mirror Python `voice` + `_voiceify`).
2. **`ComposableVoiceAgent.call()` stub** (`adapters/composable.ts`): returned a bare
   string, shadowing `defaultVoiceCall` → STT/LLM/TTS seams never fired under
   `scenario.run()`. Removed the override so it inherits `defaultVoiceCall` (like Python's
   `ComposableVoiceAgent(VoiceAgentAdapter)`).
3. **`run({ voice })` dropped** (`scenario-execution.ts` ctor): `this.config` omitted
   `voice`/`onAudioChunk`/`onVoiceEvent` → `run({ voice: { stt } })` never reached the
   judge STT pre-pass (fell back to default STT). Now copied onto `this.config`. Verified:
   swapped EL STT 0 → 1 transcribe() calls.

New unit coverage: `src/execution/__tests__/user-explicit-content-voice.test.ts` (3) locks
fix #1 offline. Unit suite: **743 passed / 1 skipped** (740 baseline + 3) — no regression.

## Recording helper (Task 1)
`examples/vitest/tests/voice/helpers/save-demo-recording.ts` — `saveDemoRecording(audio,
name)` → `javascript/recordings/<name>/` via `audio.saveSegments(dir,{manifest:true})`.
TS mirror of `python/examples/voice/_recording_helper.py`. Returns null when no segments.

## What remains (next stages)
- `/prove-it` + `/review` + docs pass + PR (no push/PR done here, per scope).
- Twilio inbound/outbound: real-phone manual run once `NGROK_AUTHTOKEN` + a second number
  are provisioned (currently `⏸`).
- Per-step `voiceStyle` audible effect still pending a style-honoring TTS (unchanged; the
  three fixes above did not touch it).
- Follow-up issue: `make voice-pipecat-down` leaves :8765 bound (kills the uv wrapper, not
  the .venv child) — teardown needs `pkill -f examples/voice/_bot/bot.py`.
- Follow-up: wire a live local-speaker playback sink so `configure({ audioPlayback })` /
  `run({ voice: { audioPlayback } })` is consumed (the value is stored + resolved today
  but nothing reads it — see `config/configure.ts` doc; Python parity uses ffplay/PyAudio).

---

# FIX PASS — /review M1 + minors/nits + recordings fidelity + JS CI (DONE)

**Branch:** `voice/372-refactor`. Closes the /review findings (`/tmp/voice-spec/
review-findings.md`) and the L975 CI gap (`/tmp/voice-spec/prove-it-results.md`).

## M1 — byte-accurate recording durations (commit `b70888f`)
Segment start/end were timestamped at the wall-clock instant `sendAudio`/`receiveAudio`
resolved, so on fast/in-process transports a multi-second turn collapsed to ~1 ms and
`manifest.duration` (+ the derived LatencyMetrics) under-reported real audio length even
though the PCM bytes were correct. Segments are now laid end-to-end on a byte-accurate
audio cursor (`voiceAudioCursor`): a segment's `endTime - startTime` equals its true PCM
length and `recording.duration` equals the `full.wav` byte-duration, gapless. Latency is
measured separately from preserved wall-clock marks. `markUserStart()` removed (vestigial).
New production-path guard `duration-fidelity.test.ts` asserts `manifest.duration ==
full.wav byte-duration` (verified it FAILS under a simulated wall-clock regression).

## Recordings — all 9 manifests byte-accurate (commit `28b15a8`)
The committed manifests pre-dated M1. 8 demos recomputed from the committed WAV
byte-lengths (no re-run — bytes were already correct); segment files renamed to the
byte-accurate offsets. **elevenlabs_branded RE-RAN** against the live EL key: its old
manifest read agent duration 0.0s / transcript null (a wall-clock artefact that LOOKED
like missing agent audio), but the agent WAV always held real speech — the fresh M1-native
run records a 3.2s agent segment (RMS ~7500), `manifest.duration 6.25s == full.wav`,
STT/LLM/TTS fired, success=true. **Verified all 9:** `manifest.duration == full.wav
byte-duration`, every segment duration == its WAV byte-duration, segment-sum == full.wav;
all WAVs <1MB.

## Review minors + nits (commit `72f46f1`)
m1 configure({audioPlayback}) doc downgraded (stored, not yet consumed). m2
proceed({interruptions}) now honours `delayRange` (samples `sampleDelay` before barging
in; was dead) + new spy test. m3 stale "PR6+" interruption comments in `voice-steps.ts`
updated (interrupt + proceed are wired; backgroundNoise stays deferred). m4
`stripAudioContent` doc → canonical `file`/`audio/pcm16`. m5 `voiceifyText`/`voiceify`
deduped into private `synthesizeToAudioMessage`. n1 `pickRandomPhrase` empty-pool guard.
n2 audio-message casts centralized (createAudioMessage returns ModelMessage; 4 redundant
`as unknown as` re-casts removed, one genuine gateway cast kept). n3 `{@link}` casing fix.

## L975 + n4 (commit `b9cd818`)
New `.github/workflows/javascript-voice-integration.yml` — TS twin of
`voice-integration.yml`: `workflow_dispatch` only, loads secrets, provisions the EL agent,
brings up the Pipecat stub bot, runs the JS @e2e voice demos, uploads
`javascript/recordings/**` (`if: always()`). Normal PR CI does NOT depend on it. n4 root
`.gitignore` broadened to `.env*` + `!.env.example` (real envs ignored, templates tracked).

## Convergence gate (held)
- **`npx tsc --noEmit` → 0 errors (CLEAN).**
- **Full unit suite (`npx vitest run`): 747 passed / 1 skipped** (746 baseline + the new
  m2 delayRange test; the 1 skip is the env-gated `twilio-tunnel` @e2e — `NGROK_AUTHTOKEN`).
- **@ts-e2e round-trip gate re-PASSES with real keys** (see fixture re-run below).
- **All 9 manifests byte-accurate; elevenlabs_branded carries real agent audio.**
- Working tree clean (only the gitignored `.env` files untracked).

## PR-readiness — user-facing docs + full local CI

**Docs (Task 1).** Added the user-facing TypeScript voice guide and reconciled the
TS capability matrix against the *shipped* surface (not the placeholder):

- **NEW** `docs/voice/typescript.md` — the comprehensive TS voice guide: the real
  public API (`scenario.pipecatAgent({...})` + `openAIRealtimeAgent` /
  `geminiLiveAgent` / `elevenLabsAgent` / `twilioAgent` / `composableAgent`; the
  `voice.*` class forms; `userSimulatorAgent({ voice })`; `judgeAgent`; script steps
  `sleep`/`silence`/`audio`/`dtmf`/`interrupt`/`voiceAgent`/`voiceProceed`;
  `voice.effects`; `result.audio`/`timeline`/`latency`; per-run `run({ voice })`),
  mirroring the PRD §6 worked examples in TS idiom.
- **REWROTE** `javascript/docs/voice/capability-matrix.md` — the prior file was a PR1
  placeholder ("no concrete adapters land yet"). Now renders the 6 shipped TS
  adapters with capability values read straight from
  `src/voice/adapters/*.ts`, plus a "not yet ported to TS" table (LiveKit / Vapi /
  generic WebRTC / generic WebSocket are Python-only) and the Pipecat-WebRTC
  `PendingTransportError` note.
- **LINKS:** `javascript/README.md` gains a *Voice Agents* section (TS-first) linking
  the guide, the TS capability matrix, and `javascript/recordings/README.md`; the
  root `README.md` voice section adds the `docs/voice/typescript.md` link alongside
  the existing happy-path / capability-matrix links.

**API fidelity — VERIFIED, no fabricated APIs.** Every symbol in the guide was
checked by typechecking a throwaway probe against `src/index.ts` (probe → tsc exit
0, then deleted). The probe caught and forced four corrections to the original
draft, all fixed in the DOC (never the code):
1. adapter **classes are `voice.*`-namespaced** (not top-level) — factories
   `scenario.pipecatAgent(...)` are the top-level idiom;
2. **effects are camelCase + positional** (`voice.effects.backgroundNoise("cafe",
   0.3)`, `phoneQuality()`, `packetLoss(0.05)`) — not snake_case `{ volume }`;
3. **`composableAgent({ stt, llm, tts })`** (STTProvider + AI-SDK LanguageModel +
   `"provider/voiceId"`) — not `{ url, protocol }`;
4. the non-blocking turn is **`scenario.voiceAgent({ wait: false })`** (the plain
   `scenario.agent(...)` is the text form), `voice.effects.custom(fn)` takes one
   arg, result fields are **`metCriteria`/`unmetCriteria`** (not passed/failed), and
   a plain step reads **`state.hasToolCall(name)`** (the `timeline` is on `result`,
   not the per-step state). The draft's "not yet wired" caveats for
   `interruptProbability`, per-step `voiceStyle`, and `interrupt({ after })` were
   dropped — all three ARE wired (Gap #8 / Tier C).

**Lint fix (Task 2).** `pnpm lint:all` (the javascript-ci "Lint" step) was RED on
HEAD: 3 `import/order` errors + 9 dead `eslint-disable no-console` directives in the
`@e2e` voice example tests (`examples/vitest/tests/voice/*`). Fixed via the package's
own `eslint . --fix` + removal of the whitespace residue. Commit `e5d0ca4`.

**Full local CI-equivalent (exact `javascript-ci.yml` steps, run from `javascript/`):**

| Step | Command | Result |
|------|---------|--------|
| Install | `pnpm install --frozen-lockfile` | ✅ exit 0 |
| Build (covers DTS) | `pnpm build:all` | ✅ exit 0 |
| Lint | `pnpm lint:all` | ✅ exit 0 (was RED at HEAD; fixed) |
| Type check | `pnpm typecheck:all` | ✅ exit 0 |
| Tests | `pnpm run test:ci` | ✅ exit 0 — **747 passed / 1 skipped** |
| Test (Examples) | `pnpm -F vitest-examples test` | ⏸ NOT run locally — needs live `LANGWATCH_API_KEY` + `OPENAI_API_KEY` (real-provider `@e2e` demos). Gated `if: github.actor != 'dependabot[bot]'`; not faked. |

Docs are markdown → not covered by `eslint .` (`**/*.{js,mjs,cjs,ts}` only), so the
doc additions do not affect lint/build/tsc/test. Working tree clean after commits.

---

# API-CONFORMANCE FIX — unify `scenario.agent({ wait })` (PRD §9 / §6.2, EDR §0)

**Branch:** `voice/372-refactor`, atop the docs commit `0ec042a`. One issue: the
non-blocking turn diverged from spec. PRD §9 (`scenario.agent({ wait: false })`),
PRD §6.2 (the flagship interruption example), and EDR §0's host-edit
("`agent()` widens to `{ wait?: boolean }`") all require **`scenario.agent({ wait:
false })`** to BE the non-blocking primitive. As-built it was a *separate* export —
`scenario.voiceAgent({...})` — so a user copy-pasting the PRD interruption example
hit a type error (a `{ wait: false }` object isn't a `string | ModelMessage`).

## What changed
- **`src/script/index.ts` — `agent` is now a single overloaded step** that owns both
  forms:
  - `agent(content?: string | ModelMessage): ScriptStep` — unchanged text behavior
    (always awaits).
  - `agent(options: VoiceAgentOptions): ScriptStep` — the non-blocking voice turn
    (`{ wait: false }` fires-and-returns; the current `voiceAgent` behavior).

  Disambiguation is **structural, not ambiguous**: a `ModelMessage` carries a
  required `role` discriminant; `VoiceAgentOptions` (`{ wait?, content? }`) does not.
  A tiny `isVoiceAgentOptions()` runtime guard routes a `role`-less plain object to
  the voice branch and everything else (string / `undefined` / message) to content.
  This was the HARD-STOP question (could `ModelMessage` structurally collide with the
  options object?) — answer: **no**, verified by a tsc probe whose negative cases
  (`{ wait: "false" }`, `{ bogus: true }`, `42`) all error as required.
- **`voiceAgent` kept as a thin alias** of the unified step (re-exported from
  `script/index.ts`). Every existing call site — demos, the interruption unit test,
  docs — keeps working unchanged, so **no recordings need re-running**.
- **`src/script/voice-steps.ts`** — the non-blocking engine is renamed `agent` →
  `voiceAgentStep` (internal; `script/index.ts` wraps it as `agent`/`voiceAgent`).
  `interrupt`/`proceed` are unaffected (they call `executor.agent()` directly).
- **Interruption unit test** (`src/script/__tests__/voice-steps.test.ts`, the
  `@ts-script-step` "agent(wait=False)…" binding) now drives the unified
  `scenario.agent({ wait: false })` (matching the Gherkin step wording in
  `specs/voice-agents.feature:380`) and asserts the `voiceAgent` alias yields the
  identical non-blocking behavior.
- **Docs lead with the PRD idiom** (`scenario.agent({ wait: false })`, alias noted):
  `docs/voice/typescript.md` (§4 heading + example, §8.2 interruption flow, the
  `interrupt`/`proceed` notes, and the rewritten "one `agent` step, two call forms"
  callout that replaced the now-false "passing `{ wait: false }` to `agent` would be
  read as a message" note) and `javascript/README.md` (worked example + surface list).

## Convergence gate (held — exact `javascript-ci.yml` steps, from `javascript/`)
| Step | Command | Result |
|------|---------|--------|
| Build (covers DTS) | `pnpm build:all` | ✅ exit 0 — emitted `dist/index.d.ts` carries both `agent` overloads + the `voiceAgent` alias |
| Lint | `pnpm lint:all` | ✅ exit 0 |
| Type check | `pnpm typecheck:all` | ✅ exit 0 (incl. `examples/vitest`) |
| Tests | `pnpm run test:ci` | ✅ exit 0 — **747 passed / 1 skipped** (the env-gated `twilio-tunnel` @e2e) |
| `agent({ wait:false })` probe | throwaway `tsc --noEmit` vs `src/index.ts` | ✅ exit 0 (4 call forms + alias + PRD §6.2 flow typecheck; 3 negative cases error); **probe deleted, not committed** |
| @ts-e2e gate | `examples/vitest` → `ts-e2e-roundtrip.test.ts` (real `OPENAI_API_KEY`) | ✅ **3 passed** — utterance survives user-sim TTS → bus → judge STT |

Working tree clean (only the gitignored `dist/`, `*.tgz`, and `.env` files untracked
— no `.env`/secret/probe committed).

---

# DEMO UPGRADE — multi-turn + interruption + persona-parity demos (DONE)

**Branch:** `voice/372-refactor`. Closes three demo gaps: demos were
single-turn; Python-parity demos were missing; there were NO interruption demos
(interruption is the flagship voice capability). Real keys, real runs, NO mocks;
committed incrementally per demo. No `python/` edits.

## Executor src fix — `agent({ wait:false }) + user()` barge-in was non-functional
The flagship interruption path was dead in the TS port: `agent({ wait:false })`
fired the agent fire-and-forget with no executor handle, so a following `user()`
ran as a SEPARATE turn — no barge-in, no `user_interrupt` event. Only
`proceed({ interruptions })` recorded interrupts. (`startVoiceTurn`/
`VoiceTurnHandle` existed but were dead code from the executor's view.) Mirrored
Python's `scenario_executor._pending_agent_task` path in TS src:
- `ScenarioExecution.agentNonBlocking()` registers the in-flight turn;
  `user()` detects it (`maybeFireUserInterrupt`) → `fireUserInterrupt`: native
  cancel (`capabilities.interruption`) + push barge-in audio (bot VAD cuts the
  reply) + record `user_interrupt` event + user segment + clear the adapter's
  pending queue (so the recovery turn doesn't re-send the audio).
- `voiceAgentStep({ wait:false })` and `interrupt()` now call `agentNonBlocking`
  (optional on `ScenarioExecutionLike`; fall back to fire-and-forget).
- `interruptResponseTime` derived from the timeline (`user_interrupt` → next
  `agent_stop_speaking`) when not explicitly set.
- **Full unit suite: 747 passed / 1 skipped — IDENTICAL to baseline (no regression).**

## Per-demo status (all real runs)
| Demo | Turns | Barge-in | Audio | Notes |
|---|---|---|---|---|
| openai_realtime_agent | 2 exchanges | — | full.wav 737KB + segments | multi-turn |
| openai_realtime_user | 2 spoken | — | full.wav 938KB + segments | two `sendText` turns |
| elevenlabs_hosted | greeting + 1 | — | full.wav 332KB + segments | live ConvAI: 2nd scripted turn times out (documented) |
| elevenlabs_branded | 2 exchanges | — | full.wav 557KB + segments | `systemPrompt` brief replies keep <1MB |
| gemini_live | 2 exchanges | — | full.wav + segments | model replies twice; trailing agent audio drop documented |
| composable_stt_swap | 2 exchanges | — | full.wav 859KB + manifest | EL STT transcribe() = 2 |
| recording_playback | 2 exchanges | — | full.wav 866KB + manifest | WAV + MP3 saved |
| voice_text_parity | 2 exchanges | — | full.wav 806KB + manifest | text leg audio undefined; voice leg 4 segs |
| pipecat_ws | 2 exchanges | — | full.wav 826KB + manifest | live bot |
| pipecat_scenario | 2 exchanges | — | full.wav 8kHz 199KB + manifest | second multi-turn smoke |
| basic_greeting | greeting + 2 | — | full.wav 8kHz 467KB + manifest | §6.1 |
| **interruption_recovery** | multi + 2 barge-ins | ✅ 2 real | full.wav 8kHz 898KB + manifest | §6.2 — `interruptResponseTime` recorded |
| **random_interruptions** | multi | ✅ real | full.wav 8kHz 238KB + manifest | §6.7 — `voiceProceed({ interruptions })` |
| **gemini_live_interruption** | 2 + interrupt | ✅ real | full.wav 8kHz 554KB + manifest | server-VAD barge-in on Gemini |
| **elevenlabs_interruption** | — | ⏸ gated | — | live ConvAI scripted-interrupt times out (4 honest tries); NOT faked. `RUN_EL_INTERRUPTION=1` |
| angry_customer | 2 exchanges | — | full.wav 8kHz 696KB + manifest | §6.3 persona + backgroundNoise + phoneQuality |
| background_handoff | multi (handoff) | — | full.wav 8kHz 223KB + manifest | §8 — `silence()` handoff |
| twilio_inbound/outbound | — | — | ⏸ MANUAL | needs 2nd number + tunnel (absent) |

Every committed `full.wav` < 1MB (long conversations downsampled to 8kHz via the
helper's new `downsampleHz`); every `manifest.duration` == `full.wav`
byte-duration (M1). The barge-in capability fires real `user_interrupt` events on
the Pipecat and Gemini transports; EL ConvAI's scripted-interrupt limitation is
documented, not faked.

## Convergence gate (held)
- `npx tsc --noEmit` (src) → **0 errors**; `examples/vitest` tsc → **0 errors**.
- Full unit suite (`npx vitest run`): **747 passed / 1 skipped** (= baseline; no
  regression from the executor barge-in wiring + latency derivation + helper).
- `@ts-e2e` round-trip gate (real `OPENAI_API_KEY`): **3 passed**.
- All 18 voice demo `@e2e` test files pass with real keys / live bot (EL
  interruption gated off; Twilio manual). Pipecat bot brought up via
  `make voice-pipecat-up` and torn down with the `pkill -f .../bot.py` fallback
  (:8765 verified free).

## Feature + helper + gitignore
- `specs/voice-agents.feature`: 8 new `@ts-*` Demo scenarios (interruption ×4,
  persona/greeting/pipecat-scenario ×4) bound by the new demo test files.
- `examples/vitest/tests/voice/helpers/save-demo-recording.ts`: auto-prunes
  `segments/*.wav` not in the fresh manifest (re-runs renamed by byte-offset);
  new `downsampleHz` option re-encodes `full.wav` for the 1MB cap.
- `.gitignore`: un-ignores the new TS recording dirs (core = +segments;
  additional = full.wav + manifest only).

---

# DEMO HONESTY PASS — promise-encoding criteria + real cut-off/noise/anger (PR #561)

**Branch:** `voice/372-refactor`. The demos were structurally-green but
behaviorally HOLLOW: interruption demos recorded a `user_interrupt` event but
never cut off a reply; `backgroundNoise` was a silent no-op in the built
package; `angry_customer` used a neutral voice; and the TS judge criteria were
weaker than Python's. Real keys, real runs, NO mocks, no `python/` edits,
commit per demo.

## Root causes found + fixed (TS src, mirror Python)
1. **Barge-in fired BEFORE the agent spoke** — `agentSpeakingEvent` was
   maintained in a private registry but NEVER published onto
   `adapter.agentSpeakingEvent`, so the executor's interrupt path always saw
   `undefined`, skipped the "wait for speech" gate, and fired into silence
   (`fired_before_speech`). Now published (+ `isSet()` is a method matching the
   interface + callers). Barge-ins land mid-utterance (`fired_after_speech`).
   Mirrors Python `adapter.py:66/199`.
2. **The cut-off reply was never marked** — added `markTruncatedAgentSegments`
   (time-containment, mirror Python `scenario_executor.py:728-740`) PLUS a
   clock-agnostic mark in `fireUserInterrupt` (mark the in-flight agent segment
   at barge-in time). The clock-agnostic path is load-bearing on transports
   where the byte-cursor segment times and wall-clock interrupt times diverge
   (Gemini receives faster than real-time → time-containment alone missed it).
3. **`backgroundNoise` was a silent NO-OP in the BUILT package** — the bundled
   effects code resolved assets via `../assets/noise` (correct in src layout)
   but tsup bundles to `dist/` where assets live at `dist/voice/assets/noise`
   (off by one dir), and the loader's `catch {}` swallowed the miss. Now probes
   candidate dirs + warns once if truly missing. Verified built dist mixes noise
   (mean|Δ| 0 → ~1500). **This means every prior committed demo's `backgroundNoise`
   never actually mixed.**
4. **Manifests unreadable on transcript-less transports** — added
   `backfillSegmentTranscripts` (executor `finally`): STT the recording segments
   the transport didn't transcribe (Pipecat over Twilio Media Streams) so the
   committed manifest reads as a conversation. The judge already transcribes for
   itself; this fills the SEGMENTS (#372 FIX #5).

## Noise assets (FIX #4)
Replaced the 0.5s byte-copies-of-Python placeholders with **3s, 24kHz PCM16,
layered, distinct, continuously-audible** ambience, generated by the new
deterministic `javascript/scripts/generate-noise-samples.mjs` (seeded → byte-
stable; boxcar coloring preserves real amplitude). Each <150KB. New
deterministic effects tests: each preset perturbs a dry signal, energy scales
with volume, presets are mutually DISTINCT, the noise loops to cover a long
turn, and the bundled assets actually load. `.gitattributes` marks audio binary.

## Criteria design — split the promise
The LLM judge can only verify CONVERSATIONAL properties from a transcript; it
CANNOT see audio properties (anger tone, noise presence, truncation — a back-
filled STT of a cut-off segment still reads grammatically). So each demo's
promise is split: **judge criteria** assert the conversational half (empathy +
resolution, acknowledging the SPECIFIC request, recovery, topic pivot — a hollow
canned/non-engaging run fails), and **code assertions** prove the audio half
(`transcriptTruncated` + shorter segment for cut-off; user-segment noise FLOOR ≫
silence for mixed ambience). This is the correct encoding of the brief's "assert
the interrupted agent segment is truncated" + "anger is audible."

## Per-demo (real runs, latest verified)
| Demo | Agent | Promise encoded | Cut-off / noise / anger | success |
|---|---|---|---|---|
| interruption_recovery | Pipecat (LLM bot) | recovered + engaged specific request; CODE: fired_after_speech + truncated≥1 + shorter + recovery | cut-off ✅ | true |
| random_interruptions | Pipecat (LLM bot) | recovered context; CODE: ≥1 agent turn truncated | cut-off ✅ (4 int / 2 trunc) | true |
| gemini_live_interruption | Gemini Live (server VAD) | two turns, 2nd mid-reply; CODE: ≥1 truncated | cut-off ✅ (1 int / 2 trunc) | true |
| elevenlabs_interruption | EL ConvAI (server VAD) | reply cut + PIVOT to business hours; CODE: ≥1 truncated | cut-off ✅ when run (gated, flaky) | (gated) |
| angry_customer | Pipecat (LLM bot) + **elevenlabs voice + [angry]/[shouting]** | empathy + resolution + heightened persona; CODE: noise floor ≫ silence | anger ✅ + noise ✅ (floor 601) | true |
| background_handoff | Pipecat (LLM bot) | agent re-engaged the return; CODE: noise floor ≫ silence | noise ✅ (floor 1512) | true |
| basic_greeting | Pipecat (LLM bot) | ENGAGED the specific pizza/delivery request (canned greeting fails) | — | true |
| pipecat_scenario | Pipecat (LLM bot) | **TRANSPORT SMOKE** — WS round-trips audio; no conversation/cut-off claim | — | true |

**Real vs the labeled smoke:** every demo above is a REAL behavior demo except
`pipecat_scenario`, which is the one explicitly-labeled transport smoke (per the
brief's "keep at most one Pipecat demo as a transport smoke"). The Pipecat
bundled bot is OpenAI-LLM-backed (real replies + honours barge-in via server
VAD), NOT a canned stub — so it is a legitimate conversational/interruption SUT
(decision recorded in `~/.claude/wisdom/2026-05-27-voice-demos-pipecat-vs-realtime.md`;
the brief's FIX #2 premise that it was a canned stub was falsified by the code).

## Convergence gate (held)
- `npx tsc --noEmit` (src) → **0**; `examples/vitest` tsc → **0**.
- Full unit suite: **759 passed / 1 skipped** (747 baseline + 12 new:
  4 noise + 7 interrupt-truncation + 1 bundled-assets-load). No regression.
- `@ts-e2e` round-trip gate (real `OPENAI_API_KEY`): **3 passed**.
- CI `lint:all` (the example workspaces) + `typecheck:all` + `build` (DTS): green.
- All 16 committed `full.wav` < 1MB; manifests byte-accurate (M1); gated EL
  demo commits no recording.

## Python follow-up items (NOT edited here — no python edits in scope)
1. **Noise placeholders:** `python/scenario/voice/assets/noise/*.wav` are the
   same 0.5s placeholders — port `generate-noise-samples.mjs` (3s, distinct).
2. **Asset-path bundling:** verify the Python package's noise-asset resolution
   isn't similarly broken at install (the TS bug was a bundler artifact; Python
   ships the source tree so likely fine, but worth a check).
3. **agentSpeakingEvent publication:** Python's base `call()` sets
   `_agent_speaking_event` directly on the adapter, so it's already wired — no
   change needed (this was a TS-port-only drop).
4. **Weak Python criteria to revisit:** the Python interruption/angry demos put
   AUDIO-property claims ("anger is audible in tone", "audio block is short")
   in the JUDGE criteria — same limitation (an LLM judge can't verify a waveform
   from a transcript). Consider moving these to code assertions in Python too
   (the TS demos now do). `angry_customer.py` may report inconclusive on the
   "noise audibly present" criterion for the same reason.
