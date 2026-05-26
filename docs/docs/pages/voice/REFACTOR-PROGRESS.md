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
