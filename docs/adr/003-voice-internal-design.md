# ADR-003: Voice Internal Design (#372)

**Date:** 2026-05-26

**Status:** Accepted

**Companion docs:** [Voice Agents API Design Proposal (Notion PRD)](https://www.notion.so/langwatchdata/Claude-Opus-1-Proposal-3125e165d48280eca9dbe044884213c8) · [ADR-001 Concurrency](./001-scenario-concurrency-model.md) · [ADR-002 Voice Provider State](./002-voice-provider-state.md)

_This is an Engineering Design Record — it sits between the PRD and the PRs and is the thing review checks the code against. Committed at repo-root `docs/adr/003-voice-internal-design.md` alongside ADR-001 and ADR-002 (not under `javascript/docs/`)._

## Why this doc exists

The PRD specifies the **public API** for voice testing — thoroughly. It says nothing about
**how it's built inside**. That vacuum produced, in the first implementation pass:

- a **global STT provider singleton** (`voice/stt.ts`) that violates ADR-001 and is unsafe
  under concurrent runs;
- an **invented `scenario.configure({ stt })`** API present in no other PR and not in Python;
- a path toward a **3-way `voice/index.ts` collision** across flat-sibling PRs;
- tests bound to a **non-existent `@ts-stt` tag** and a **non-existent "judge requests a
  transcript"** behavior.

These are not sloppiness — they're what happens when 11 PRs are cut from an API spec with no
internal model to fit. This doc supplies that model: the seams voice plugs into, where state
lives, who owns lifecycle, the data model, the public/internal seam, and a PR→design map that
salvages the flat siblings into a fresh clean stack with a runnable top (the siblings are then closed).

**Two assumptions this doc takes as fixed:**
- **The public API is decided.** The PRD's surface (`run({...})`, the adapter classes, the
  script steps, `result.audio`/`timeline`/`latency`) stands. The *only* API delta below is
  the **removal** of `scenario.configure({ stt })` — an API the PRD never specified.
- **The user stories hold.** The `specs/voice-agents.feature` scenarios are the contract.
  This design serves them; it does not relitigate them.

Everything below is therefore about the **inside of the box**: where the new `voice/`
modules attach, where their state lives, and what each module is responsible for.

---

## 0. Module tree (the target)

The post-#372 layout. Modules only (no tests, helpers, or asset blobs). Markers:
**(new)** doesn't exist yet · **(exists)** stable host, structurally untouched ·
**(moved)** exists but relocates under this design · **(removed)** deleted ·
**→ edit / +field / +steps** existing file gets a small additive change.
⚠ marks the **design deltas** over "merge the 11 PRs as-is" — the four things this record
changes (see §7).

```
javascript/src/
│
├── voice/                                  (new — the entire feature; a leaf off the host)
│   ├── index.ts                            (new)  barrel — appended per stacked PR, never rewritten
│   ├── config.ts                       ⚠   (new)  VoiceConfig {stt, tts, judge knobs} → rides on ScenarioConfig (replaces the global)
│   ├── adapter.ts                          (new)  VoiceAgentAdapter extends AgentAdapter
│   ├── adapter.runtime.ts                  (new)  executor wiring: connect/disconnect lifecycle, VAD fallback
│   ├── capabilities.ts                     (new)  AdapterCapabilities — what a transport supports
│   ├── audio-chunk.ts                      (new)  AudioChunk — canonical PCM16 / 24kHz / mono
│   ├── messages.ts                         (new)  audio ModelMessage construction
│   ├── messages.types.ts               ⚠   (new)  audio content-part types — reconcile to AI-SDK `file` (§4.2)
│   ├── vad.ts                              (new)  voice-activity detection (interruption support)
│   ├── interruption.ts                     (new)  interrupt timing / strategy
│   ├── transcribe.ts                       (new)  per-run STT pass over audio messages
│   ├── judge-stt.ts                    ⚠   (new)  judge transcription hook — NET-NEW (PRD wrongly says "extend existing")
│   ├── recording.runtime.ts                (new)  accumulates segments/timeline during a run
│   ├── recording.types.ts                  (new)  VoiceRecording / VoiceEvent / LatencyMetrics
│   ├── voice-executor-state.ts             (new)  recording/timeline/latency fields → merge into ScenarioExecutionState
│   ├── voice-models.ts                     (new)  provider/voice string routing ("openai/nova")
│   │
│   ├── stt/                            ⚠   (moved — was a single stt.ts; one file per provider)
│   │   ├── index.ts                        (new)
│   │   ├── stt-provider.ts                 (new)  STTProvider interface + resolve-from-config  (replaces global setSttProvider/getSttProvider — removed)
│   │   ├── openai-stt.ts                    (moved) OpenAISTTProvider (default: gpt-4o-transcribe)
│   │   └── elevenlabs-stt.ts                (moved) ElevenLabsSTTProvider
│   │
│   ├── tts/                            ⚠   (moved — was a single tts.ts)
│   │   ├── index.ts                        (new)
│   │   ├── tts.ts                           (moved) synthesize() + LRU cache (invariant preserved)
│   │   └── openai-tts.ts                    (moved) default OpenAI TTS provider
│   │
│   ├── effects/                            (new — PRD §4.5)
│   │   ├── index.ts                         (new)
│   │   ├── noise.ts                          (new)  background_noise
│   │   ├── quality.ts                        (new)  phone_quality / low_quality / packet_loss
│   │   ├── prosody.ts                        (new)  speaking_fast/slow, volume
│   │   ├── common.ts                         (new)  shared effect plumbing
│   │   └── custom.ts                         (new)  user fn(bytes) -> bytes
│   │
│   ├── adapters/                           (new — one file per platform, per PRD §4.1)
│   │   ├── index.ts                         (new)
│   │   ├── composable.ts                     (new)  shared transport composition
│   │   ├── pipecat.ts                        (new)  PipecatAgent (WS + WebRTC)
│   │   ├── openai-realtime.ts                (new)  OpenAIRealtimeAgent  (also migrates legacy realtime path to `file` parts — §4.2)
│   │   ├── gemini-live.ts                    (new)  GeminiLiveAgent
│   │   ├── elevenlabs.ts                     (new)  ElevenLabsAgent (platform)
│   │   ├── eleven-labs-voice-agent.ts        (new)  ElevenLabs convAI transport
│   │   ├── twilio.ts                         (new)  TwilioAgent (phone)
│   │   ├── twilio-server.ts                  (new)  media-stream server
│   │   ├── twilio-tunnel.ts                  (new)  tunnel harness
│   │   ├── twilio-shared.ts                  (new)
│   │   └── pending-transport-error.ts        (new)
│   │
│   └── assets/noise/                       (new — bundled WAVs, <1MB)
│
├── domain/
│   ├── agents/index.ts                     (exists)  AgentAdapter.call(input) — THE seam; AgentInput carries scenarioConfig
│   ├── scenarios/index.ts          +field  (exists)  ScenarioConfig gains `voice?: VoiceConfig`
│   └── core/{config,execution}.ts          (exists)  ScenarioProjectConfig, ScenarioExecutionStateLike
│
├── execution/
│   ├── scenario-execution.ts        → edit  (exists)  calls voice adapter connect/disconnect; attaches voice result
│   └── scenario-execution-state.ts  +fields (exists)  absorbs voice-executor-state fields
│
├── runner/run.ts                    → edit  (exists)  optional RunOptions.voice override → seed cfg.voice at the run() boundary
│
├── agents/
│   ├── judge/judge-agent.ts         → edit  (exists)  STT pass before buildTranscriptFromMessages
│   ├── user-simulator-agent.ts      → edit  (exists)  TTS on call() when voice config present
│   └── realtime/                  reconcile (exists)  fold into voice/adapters/openai-realtime + `file` format (§4.2)
│
├── script/index.ts                  +steps  (exists)  sleep / silence / audio / interrupt / dtmf
│
├── config/
│   ├── configure.ts                    ⚠    (exists → CHANGE)  remove invented configure({stt}); configure() stays for global exec settings only
│   ├── get-project-config.ts               (exists)
│   └── index.ts                            (exists)
│
└── index.ts                                (exists)  `export * as voice` already correct — no barrel collision by design
```

**The whole design delta is four markers (⚠):** (1) `stt.ts`/`tts.ts` → `stt/`+`tts/`
(one file per provider); (2) global provider → `config.ts` + `ScenarioConfig.voice`
(per-run); (3) `configure({stt})` removed; (4) one audio message format. Everything else is
the existing stack's `voice/` leaf as-built, plus small additive edits to the host. The
per-module responsibility + boundary-contract catalog for each entry follows in **§0.1**
(populated from the clean-room vs as-built contract analysis).

---

## 0.1 Per-module contract catalog (target vs as-built — gap analysis)

Each module in the tree above gets one entry. The columns:

- **Responsibility** — why the module exists and what it deliberately does *not* do. From Agent A's clean-room contracts (designed from the PRD + locked decisions, written *without* reading the PR code).
- **Public API (target)** — the ideal exported signatures. The locked design — what review checks the code against.
- **Boundary types** — what the module *owns* (defines) vs *consumes* (imports across a seam).
- **As-built** — what exists in the 10 open PRs today (#511/PR1 is merged into base), with the PR ref, and the key divergences. `ABSENT` = not built yet.
- **Gap → action** — the delta to close, referencing the numbered entry in Agent B's GAP TABLE (Appendix B) where one applies, plus the concrete next step.

"Target" = the locked design; "as-built" = current PR reality; "gap" = the work. Where A and B agree the module is already correct, the entry says so in one line. Eleven gaps are numbered (Gap #1–#11); they cluster in four modules (`stt/`, `config.ts`, `messages.ts`/`adapter.runtime.ts`, `recording.runtime.ts`) — the rest of the tree is largely additive scaffolding that exists byte-identical from the merged #511 base or is a clean leaf.

---

### Tier 0 — Barrel

#### `voice/index.ts`
**Responsibility:** Single public barrel. Re-exports adapter factories/classes, the `effects` namespace, the voice script steps, `VoiceConfig`, and the public result types. No behavior, no executor wiring.
**Public API (target):** re-export `pipecatAgent`/`openAIRealtimeAgent`/`geminiLiveAgent`/`elevenLabsAgent`/`twilioAgent`/`composableAgent` (+ class forms); `effects`; `sleep`/`silence`/`audio`/`dtmf`/`interrupt`; `InterruptionConfig`; types `VoiceConfig`/`SttConfig`/`TtsConfig`, `VoiceRecording`/`VoiceEvent`/`LatencyMetrics`/`AudioSegment`, `AudioChunk`, `VoiceAgentAdapter`.
**Boundary types:** Owns nothing (pure re-export). Consumes every public type below.
**As-built:** Exists but is **unique per PR ref** — each of the 10 flat-sibling branches (#511/PR1 is merged into base, no longer a sibling) has its own divergent `voice/index.ts` (Agent B, forked-files list). No append-only discipline because the PRs are siblings, not a stack.
**Gap → action:** Not a numbered gap, but the load-bearing consequence of the flat-sibling layout. The barrel is the canonical merge-collision site. Action: enforce §5.1's "one owner per stacked PR, append never rewrite" once the re-stack (§6) lands; reconcile the divergent copies into a single append-only barrel.

---

### Tier 1 — Config & message gateway (the contract core)

#### `voice/config.ts`  ⚠
**Responsibility:** Per-run voice config that rides on `ScenarioConfig.voice` — the carrier that reaches `call()` — plus the resolver (`cfg.voice?.stt ?? default`, with an optional `RunOptions.voice` override folded in at the `run()` boundary). The single place provider selection / default voice / default format / default models resolve. Does NOT instantiate providers, read stray env, or mutate inputs.
**Public API (target):** `VoiceConfig {stt?:SttConfig; tts?:TtsConfig; defaultAudioFormat?; audioPlayback?}`; `SttConfig {model; language?; apiKey?}`; `TtsConfig {voice; format?; apiKey?}`; `ResolvedVoiceConfig`; `resolveVoiceConfig(optionLevel, scenarioLevel, defaults?)`; `DEFAULT_STT_MODEL`, `DEFAULT_AUDIO_FORMAT`.
**Boundary types:** Owns `VoiceConfig`, `SttConfig`, `TtsConfig`, `ResolvedVoiceConfig`. Consumes `AudioFormat`. Host `ScenarioConfig` gains `voice?: VoiceConfig` (module owns the type, host owns the field).
**As-built:** **ABSENT** (Gap #7). The whole per-run config object and its resolver do not exist. Provider state is instead a module global in `stt.ts` (`let provider = new OpenAISTTProvider()`), and the only "configuration" entry point is the invented `config/configure.ts` two-line `setSttProvider` if-block.
**Gap → action:** Gap #7 — create `voice/config.ts` with `VoiceConfig` + `resolveVoiceConfig`. This is the keystone of the per-run state model (§2): it replaces both the global (Gap #1) and `configure({stt})` (Gap #2). The carrier that reaches `call()` is `cfg.voice` (`cfg.voice?.stt ?? default`); an optional `RunOptions.voice` override may seed it at the `run()` boundary (`options?.voice ?? cfg.voice ?? default`).

#### `voice/audio-chunk.ts`
**Responsibility:** Canonical raw-audio value type (buffer + format descriptor) + pure metadata helpers. Lingua franca across transports / effects / TTS / STT / recording. No DSP, no FS, no message/provider knowledge.
**Public API (target):** `AudioEncoding` union; `AudioFormat {encoding; sampleRate; channels}`; `AudioChunk {data:Uint8Array; format; transcript?; timestamp?}`; `durationSeconds`, `isCompatible`, `describeFormat`; `PCM16_24K`, `MULAW_8K`.
**Boundary types:** Owns `AudioChunk`, `AudioFormat`, `AudioEncoding`. Consumes none. Leaf.
**As-built:** Exists, **byte-identical from the merged #511 base** across all forks (Agent B, byte-identical list).
**Gap → action:** As-built matches target — no change.

#### `voice/messages.types.ts`  ⚠
**Responsibility:** Types-only — the AI-SDK `file` audio-part shape + "audio message" typing. Shared by the builder and consumers without a circular runtime import. Nails the ONE in-message format. No conversion logic, no provider shapes.
**Public API (target):** `AudioFilePart = FilePart & { mediaType: \`audio/${string}\` }`; `AudioMessage = ModelMessage`; `AudioMessageParts {audio; transcript?}`.
**Boundary types:** Owns `AudioFilePart`, `AudioMessage`, `AudioMessageParts`. Consumes `ModelMessage`/`FilePart`/`TextPart` (`ai`).
**As-built:** Exists, **byte-identical from the merged #511 base** (Agent B). However the *type* nails the AI-SDK `file` part, while the live producers in `messages.ts` and the adapters emit OpenAI-convention `input_audio`/`audio` shapes — so the type and the runtime disagree (root of Gap #3).
**Gap → action:** The type is correct as the single in-message format target (§4.2). Action: make the runtime conform to it — see `messages.ts` (Gap #3). Type file itself: no change.

#### `voice/messages.ts`  ⚠ (LIVE BUG site)
**Responsibility:** The SOLE runtime gateway `AudioChunk ↔ ModelMessage`: `createAudioMessage`, `extractAudio`, `hasAudio`, `extractTranscript`, `attachTranscript`. The one place the in-message format is built and parsed. No STT/TTS, no provider-native shapes, no state.
**Public API (target):** as above.
**Boundary types:** Owns the `createAudioMessage`/`extractAudio` contract. Consumes `AudioChunk`, `AudioFilePart`/`AudioMessage`, `ModelMessage`.
**As-built:** Exists, but is **one of two divergent producers** (Gap #3, #5). `messages.ts#createAudioMessage` emits a **WAV** payload tagged `format:"wav"`; `adapter.runtime.ts` emits **raw PCM16** tagged `format:"pcm16"`. There are TWO `createAudioMessage` implementations with different signatures across the forks (Gap #5). Their paired extractors decode by the format tag, so cross-feeding one producer's message to the other's extractor decodes a **WAV header as audio samples**.
**Gap → action:** Gap #3 — **LIVE BUG.** Standardize on one in-message format (the AI-SDK `file` part per §4.2) with one encoder and one extractor; de-dupe to a single `createAudioMessage` (Gap #5). This is a correctness fix, not drift — it must land during format standardization. See §7.8 and the round-trip assertion in §8.

#### `voice/capabilities.ts`
**Responsibility:** Capability flags a component advertises + pure predicates. Judge auto-detect (audio-capable model?), adapter advertise (interruption / DTMF / streaming / barge-in). Makes PRD auto-detection data-driven. No mutable provider lists (→ `voice-models.ts`), no side effects.
**Public API (target):** `VoiceCapabilities {supportsInterruption; supportsDtmf; supportsStreamingTranscript; supportsBargeIn; bidirectionalAudio}`; `JudgeAudioCapability {acceptsAudioInput}`; `defaultCapabilities`, `canInterrupt`.
**Boundary types:** Owns `VoiceCapabilities`, `JudgeAudioCapability`. Consumes none.
**As-built:** Exists, **byte-identical from the merged #511 base** (Agent B).
**Gap → action:** As-built matches target — no change.

---

### Tier 2 — Audio mechanics (VAD, interruption policy)

#### `voice/vad.ts`
**Responsibility:** VAD contract (AudioChunk stream → speech-start/stop events) + a default energy-threshold impl. Mechanism for utterance timing / latency / silence. Does NOT decide what to do on events (that is `interruption.ts` / executor); no provider, no transport.
**Public API (target):** `VadEventType`; `VadEvent {type; timestamp}`; `VadOptions {energyThreshold?; silenceMs?; minUtteranceMs?}`; `Vad {push(chunk):VadEvent[]; reset()}`; `createEnergyVad`.
**Boundary types:** Owns `Vad`, `VadEvent`, `VadEventType`, `VadOptions`. Consumes `AudioChunk`.
**As-built:** Exists (carried by adapter-runtime PRs). Holds a `private static warnedAdapters = new Set()` (Agent B smell inventory) — a type-level dedupe-warning set; per-class, low-risk, not a per-run state leak.
**Gap → action:** No numbered gap. Minor smell: the static `warnedAdapters` set is process-global; harmless for warnings but note it stays out of any per-run path. Otherwise matches target.

#### `voice/interruption.ts`
**Responsibility:** The MODEL of interruption — `InterruptionConfig` for `proceed()`, per-sim `interrupt_probability`, and pure decision logic (interrupt? after how long? which phrase strategy?). Policy separable from mechanism. Does NOT send audio / drive transport / generate TTS — it returns an instruction. Does NOT own the `interrupt()` step.
**Public API (target):** `InterruptionStrategy`; `InterruptionConfig {probability; delayRange?; strategy?}`; `InterruptionDecision {interrupt; afterSeconds?; phrase?}`; `decideInterruption(config, rng?)`; `RANDOM_INTERRUPT_PHRASES`.
**Boundary types:** Owns `InterruptionConfig`, `InterruptionStrategy`, `InterruptionDecision`. Consumes none (RNG injected).
**As-built:** Exists but is **config-only** (Agent B, Gap #9): it holds the `InterruptionConfig` shape, but the decision/execution machinery that consumes it is unhomed. The `voiceProceed({interruptions})` verb that would consult it is referenced (PR5/#538) but **implemented nowhere** (Gap #8).
**Gap → action:** The policy types are fine. Gap #8 — the executor verb that consults `decideInterruption` per turn must be implemented in the runtime layer (`adapter.runtime.ts` + `voice-executor-state.ts`). Tied to A's closing-note risk #1 (the interruption seam).

---

### Tier 3 — STT subtree

#### `voice/stt/stt-provider.ts`
**Responsibility:** Narrow STT provider interface + a registry/router mapping `"provider/model"` → instance. `transcribe.ts` depends on the interface, not the concretes (DIP). No transcription, no clients, no provider-count knowledge.
**Public API (target):** `SttResult {text; language?}`; `SttProvider {name; transcribe(audio, {model; language?; apiKey?})}`; `resolveSttProvider(model)`; `registerSttProvider(provider)`.
**Boundary types:** Owns `SttProvider`, `SttResult`. Consumes `AudioChunk`, an `SttConfig` slice.
**As-built:** Partially present but **fused with state and duplicated** (Gap #1, #5). The interface lives in `stt.ts` next to the module global `let provider = new OpenAISTTProvider()` (Agent B smell inventory, `stt.ts`), and a second divergent `STTProvider` signature exists inside `adapters/composable.ts` with a docstring admitting "should converge" (Gap #5).
**Gap → action:** Gap #1 + #5 — extract the interface + router into `stt/stt-provider.ts`, drop the module global (state moves to per-run `config.ts`), and de-dupe the `composable.ts` copy to import this one. This is the `stt.ts` → `stt/` split (design delta ⚠).

#### `voice/stt/openai-stt.ts`
**Responsibility:** Leaf — `OpenAISttProvider` implements `SttProvider` against OpenAI transcription (whisper / gpt-4o-transcribe). Owns the OpenAI-edge `AudioChunk` → upload conversion. No routing, no other vendors, no message/judge.
**Public API (target):** `class OpenAISttProvider implements SttProvider`. Self-registers via `stt/index.ts`.
**Boundary types:** Consumes `SttProvider`, `AudioChunk`.
**As-built:** Exists inside the single `stt.ts` (default model `gpt-4o-transcribe`, per Agent B model-constants), not yet a standalone leaf file. Re-implements a private `pcm16ToWav` (one of four duplicate WAV encoders — Agent B).
**Gap → action:** Gap #1 (the `stt/` split) — move into `stt/openai-stt.ts`. Boy-scout: replace its private `pcm16ToWav` with the shared WAV encoder once one exists (see §7 smell, four-way WAV dup).

#### `voice/stt/elevenlabs-stt.ts`
**Responsibility:** Leaf — `ElevenLabsSttProvider` (Scribe). Same `SttProvider` contract, different backend.
**Public API (target):** `class ElevenLabsSttProvider implements SttProvider`.
**Boundary types:** Consumes `SttProvider`, `AudioChunk`.
**As-built:** Exists inside `stt.ts` (model `scribe_v1`, per Agent B model-constants), co-located with the OpenAI provider — the Python-style cramping the design explicitly improves on (§5.3).
**Gap → action:** Gap #1 — move into `stt/elevenlabs-stt.ts`, one file per provider.

#### `voice/stt/index.ts`
**Responsibility:** Barrel + registration site; side-effect-imports the concrete providers so they self-register; re-exports the interface + router.
**Public API (target):** re-export `SttProvider`/`SttResult`/`resolveSttProvider`; side-effect registers.
**Boundary types:** none.
**As-built:** **ABSENT** as a directory barrel (the `stt/` directory does not exist yet; everything is the flat `stt.ts`).
**Gap → action:** Gap #1 — create as part of the `stt/` split.

#### `voice/transcribe.ts`
**Responsibility:** The automatic STT PASS over messages. Finds audio `file` parts lacking a transcript, resolves an `SttProvider`, transcribes, and attaches via `messages.ts#attachTranscript`. The "STT upstream" mechanism — the one place transcription happens. Does NOT format judge input (`judge-stt.ts`), asks the registry for the provider, returns a new list (no in-place mutation).
**Public API (target):** `transcribeMessages(messages, Pick<ResolvedVoiceConfig,"stt">): Promise<ModelMessage[]>`; `transcribeChunk(audio, config): Promise<string>`.
**Boundary types:** Owns the transcription-pass contract. Consumes `resolveSttProvider`, `ResolvedVoiceConfig`, `messages.ts` helpers, `AudioChunk`, `ModelMessage`.
**As-built:** Logic exists but reads the **module global** rather than a resolved per-run config, and is entangled with the WAV-emitting `messages.ts` producer (Gaps #1, #3).
**Gap → action:** Re-point at `resolveSttProvider` (from `stt-provider.ts`) and accept the `ResolvedVoiceConfig` slice rather than reading a global (Gap #1). Depends on the format fix (Gap #3) so the parts it scans are the canonical `file` shape.

#### `voice/judge-stt.ts`  ⚠
**Responsibility:** The seam hooking transcription into the judge path **before** `buildTranscriptFromMessages`; decides judge input (always text via transcribe; audio passthrough when the model is audio-capable; timeline when voice present). Keeps the judge agent unchanged. Does NOT run STT itself (→ `transcribe.ts`), does NOT format the timeline string (→ `recording.runtime.ts`), no verdict.
**Public API (target):** `JudgeAudioOptions {includeAudio?; includeTimeline?; includeTraces?}`; `JudgePreparedInput {messages; timelineText?}`; `prepareJudgeInput({messages; config; judgeModel; timeline?; options?}): Promise<JudgePreparedInput>`.
**Boundary types:** Owns `JudgeAudioOptions`, `JudgePreparedInput`. Consumes `transcribeMessages`, `JudgeAudioCapability`, `VoiceEvent`, `ResolvedVoiceConfig`, `ModelMessage`.
**As-built:** **NET-NEW** and partially modeled by PR4/#528 (which correctly implements "audio auto-transcribed → judge gets text"). The PRD's claim that it "extends existing `wrapJudgeForAudioTranscription`" is false — that function does not exist as a `src` library API; it ships only as a committed example helper at `javascript/examples/vitest/tests/helpers/` (§3.3, Gap-adjacent to §7.7).
**Gap → action:** Build `judge-stt.ts` as the explicit pre-judge hook. Reconcile against PR4's modeling. Carries A's closing-note risk #5 (the host judge can't see this transform — the executor must invoke the pre-pass when `cfg.voice` is present and a judge is in the lineup). No numbered gap; it is the §7.7 + §3.3 correction.

---

### Tier 4 — TTS subtree

#### `voice/tts/tts.ts`  ⚠
**Responsibility:** Narrow TTS provider interface + a `"provider/voice"` router (litellm-style). The simulator depends on the interface, not the concretes. No synthesis / clients / effects. Also home of `synthesize()` + the LRU cache (the cache invariant — keyed on `sha256(text)+voice`, effects applied after cache read — is correct and tested; preserve it).
**Public API (target):** `TtsRequest {text; voice; format?; style?; apiKey?}`; `TtsProvider {name; synthesize(req):Promise<AudioChunk>}`; `resolveTtsProvider(voiceSpec)`; `registerTtsProvider`.
**Boundary types:** Owns `TtsProvider`, `TtsRequest`. Consumes `AudioChunk`/`AudioFormat`.
**As-built:** Exists as a single `tts.ts` with `const PROVIDERS = new Map()` (registry, self-registers OpenAI at import) and `const CACHE = new Map()` (LRU, max 64) — both module globals (Agent B smell inventory, `tts.ts`). A second divergent `synthesize` signature exists in `adapters/composable.ts` (Gap #5). The `PROVIDERS`/`CACHE` globals are acceptable per §3.2 (the cache is provider-agnostic and effect-safe).
**Gap → action:** Gap #5 — de-dupe the `composable.ts` `synthesize` copy to import this one. The `tts.ts` → `tts/` split (design delta ⚠) is cosmetic relocation; the cache global is explicitly *kept* (§2.2 / §3.2). Replace its private `pcm16ToWavBytes`-equivalent with the shared encoder if it has one (four-way WAV dup, §7 smell).

#### `voice/tts/openai-tts.ts`
**Responsibility:** Leaf — `OpenAITtsProvider` (nova/alloy). Owns the OpenAI-edge request + response → `AudioChunk`. No routing / other vendors / effects.
**Public API (target):** `class OpenAITtsProvider implements TtsProvider`.
**Boundary types:** Consumes `TtsProvider`, `AudioChunk`.
**As-built:** Exists inside `tts.ts` (model `gpt-4o-mini-tts`, per Agent B model-constants), self-registers at import.
**Gap → action:** Gap #10-adjacent — relocate into `tts/openai-tts.ts` in the split. No behavior change.

#### `voice/tts/elevenlabs-tts.ts` — OPEN DECISION
**Responsibility:** (target, *if* adopted) Leaf — `ElevenLabsTtsProvider`, same `TtsProvider` contract, ElevenLabs backend (e.g. `eleven_v3` / voice `rachel`). Mirror of `elevenlabs-stt.ts`.
**Public API (target):** `class ElevenLabsTtsProvider implements TtsProvider` (proposed).
**Boundary types:** Consumes `TtsProvider`, `AudioChunk`.
**As-built:** **ABSENT as a leaf** (Gap #10). ElevenLabs TTS exists *only inside* `adapters/composable.ts` (model `eleven_v3`, voice id `EXAVITQu4vr4xnSDxMaL`, per Agent B). The fixed tree lists only `openai-tts.ts`, yet the PRD headline uses `elevenlabs/rachel` — so as-built `voice="elevenlabs/..."` has no registered TTS backend.
**Gap → action:** **Gap #10 — OPEN DECISION for review:** add a dedicated `tts/elevenlabs-tts.ts` leaf (symmetric with STT, satisfies the PRD headline) **vs.** keep ElevenLabs TTS composable-only (intentional OpenAI-TTS-first, EL via the composable agent). The interface + router admit the leaf later without a consumer change either way. Flagged by both A (closing-note #4) and B (Gap #10).

#### `voice/tts/index.ts`
**Responsibility:** Barrel + registration, mirrors `stt/index.ts`.
**Public API (target):** re-export `TtsProvider`/`TtsRequest`/`resolveTtsProvider`; side-effect registers concretes.
**Boundary types:** none.
**As-built:** **ABSENT** as a directory barrel (the `tts/` directory does not exist yet; flat `tts.ts`).
**Gap → action:** Create as part of the `tts/` split.

---

### Tier 5 — Effects

#### `voice/effects/common.ts`
**Responsibility:** The shared `AudioEffect` contract (named `AudioChunk → AudioChunk`, maybe async) + the ordered composition runtime. Uniform shape for built-in + custom. No specific effects, no assets, no simulator knowledge.
**Public API (target):** `AudioEffect {name; apply(input):Promise<AudioChunk>|AudioChunk}`; `applyEffects(input, effects[])`.
**Boundary types:** Owns `AudioEffect`. Consumes `AudioChunk`.
**As-built:** Exists (PR6/#537 — effects module + noise assets).
**Gap → action:** No numbered gap. Confirm the `AudioEffect` shape matches A's contract during the re-stack; otherwise as-built.

#### `voice/effects/noise.ts`
**Responsibility:** Leaf — additive environmental effects: `background_noise(preset, volume)`, `static(intensity)`, `multiple_voices(bg)`, `echo(delayMs)`. Owns mixing with bundled samples or a custom WAV. Not quality / prosody.
**Public API (target):** `background_noise`, `static_`, `echo`, `multiple_voices` (all → `AudioEffect`).
**Boundary types:** Consumes `AudioEffect`, `AudioChunk`; reads `assets/noise/` WAVs.
**As-built:** Exists (PR6/#537). Note: PR5/#538 references a `backgroundNoise()` executor verb that is **implemented nowhere** (Gap #8) — distinct from this effect factory.
**Gap → action:** Gap #8 touches the *executor verb*, not this leaf. This module: confirm against target, otherwise no change.

#### `voice/effects/quality.ts`
**Responsibility:** Leaf — channel / codec effects: `phone_quality`, `low_quality(bitrate)`, `packet_loss(prob)`, `low_volume`, `high_volume`, `breaking_up`. Owns the filter / compress / dropout DSP.
**Public API (target):** as above (→ `AudioEffect`).
**Boundary types:** Consumes `AudioEffect`, `AudioChunk`.
**As-built:** Exists (PR6/#537).
**Gap → action:** No numbered gap — confirm against target, otherwise no change.

#### `voice/effects/prosody.ts`
**Responsibility:** Leaf — speech timbre / rate: `speaking_fast`, `speaking_slow`, `robotic`. Time-stretch (pitch-preserving) + vocoder. Accents are NOT here (that is a TTS voice choice).
**Public API (target):** `speaking_fast`, `speaking_slow`, `robotic`.
**Boundary types:** Consumes `AudioEffect`, `AudioChunk`.
**As-built:** Exists (PR6/#537).
**Gap → action:** No numbered gap — confirm against target, otherwise no change.

#### `voice/effects/custom.ts`
**Responsibility:** Adapt a user fn (`Uint8Array → Uint8Array | Promise`) into an `AudioEffect`, format-preserving. The escape hatch.
**Public API (target):** `custom(fn, {name?}): AudioEffect`.
**Boundary types:** Consumes `AudioEffect`.
**As-built:** Exists (PR6/#537).
**Gap → action:** No numbered gap — confirm against target, otherwise no change.

#### `voice/effects/index.ts`
**Responsibility:** Assemble the public `effects` namespace exactly as the PRD uses it (`scenario.effects.background_noise(...)`), mapping `static_` → `static`. No logic.
**Public API (target):** `effects` object with all factories; export `AudioEffect`.
**Boundary types:** Consumes all effect leaves.
**As-built:** Exists (PR6/#537).
**Gap → action:** No numbered gap. Plugs into `voice/index.ts`; consumed by the simulator voice path + per-step overrides. Otherwise no change.

---

### Tier 6 — Adapter base & runtime

#### `voice/adapter.ts`  (LIVE BUG co-site via runtime fork)
**Responsibility:** The PUBLIC `VoiceAgentAdapter` abstract — the audio-native extension of the host `AgentAdapter` with `connect`/`disconnect`/`sendAudio`/`recvAudio` + a default `call()` shape (send → recv → audio `ModelMessage`). Shared base for platform + custom adapters; the executor recognizes the lifecycle. No transport logic (→ `adapter.runtime`/leaves), no recording, no platform knowledge.
**Public API (target):** `abstract class VoiceAgentAdapter extends AgentAdapter { role; abstract capabilities:VoiceCapabilities; responseTimeout?; abstract connect/disconnect/sendAudio(AudioChunk)/recvAudio(timeout?); call(input):Promise<AgentReturnTypes> }`.
**Boundary types:** Owns the `VoiceAgentAdapter` base. Consumes `AgentAdapter`/`AgentRole`/`AgentInput`/`AgentReturnTypes`, `AudioChunk`/`AudioFormat`, `VoiceCapabilities`, `messages.ts` helpers.
**As-built:** Exists but as **3 DISJOINT forks at the same path** (Gap #4): baseline / pr-515 (adds the default `call()`) / pr-538 (adds `sendDtmf` + `AgentSpeakingEvent`). A naive merge silently drops one side. Also, whether `call()` is abstract or a concrete default is **inconsistent** across leaves (Gap #11): PR515 ships a default, while realtime/gemini/pipecat/twilio override it to throw or stub.
**Gap → action:** Gap #4 — merge the three forks into one base carrying `call()` + `sendDtmf` + `AgentSpeakingEvent`. Then Gap #11 — settle abstract-vs-default `call()` *after* the merge so every leaf agrees. Highest-risk merge in the tree (Agent B `concern`).

#### `voice/adapter.runtime.ts`  ⚠ (LIVE BUG site)
**Responsibility:** Concrete runtime helpers shared by transport adapters: the default `call()` (send last user audio → recv with timeout → build msg), lifecycle bookkeeping, the bridge letting a non-blocking `agent({wait:false})` start a recv without awaiting, and wiring local VAD for the timeline. Keeps the leaves tiny. Does NOT open sockets (leaves), does NOT define the public base (`adapter.ts`), no platform shapes.
**Public API (target):** `runVoiceTurn(adapter, input, {recorder?}): Promise<AgentReturnTypes>`; `startVoiceTurn(...): VoiceTurnHandle`; `VoiceTurnHandle {injectAudio(audio):Promise<void>; finish():Promise<AgentReturnTypes>}`.
**Boundary types:** Owns `VoiceTurnHandle`. Consumes `VoiceAgentAdapter`, `AgentInput`/`AgentReturnTypes`, `AudioChunk`, `Recorder`, `Vad`.
**As-built:** Exists (PR3/#515). Its `createAudioMessage`-equivalent emits **raw PCM16** tagged `format:"pcm16"` — the OTHER half of the Gap #3 LIVE BUG (the `messages.ts` half emits WAV+`"wav"`). Holds two `WeakMap` registries — `vadRegistry` and `speakingEventRegistry` (Agent B smell inventory) — which are per-adapter-instance keyed, so acceptable (not per-run globals). Re-implements `encodeWav` (one of four WAV dups).
**Gap → action:** Gap #3 — **LIVE BUG**: reconcile this producer with `messages.ts` to a single format + extractor (§4.2: AI-SDK `file` parts). Implement the missing `startVoiceTurn`/`VoiceTurnHandle` interruption bridge and the `voiceProceed`/`backgroundNoise` verbs that are referenced but unimplemented (Gap #8). The `WeakMap` registries are fine to keep.

#### `voice/voice-executor-state.ts`
**Responsibility:** PER-RUN (non-global) live-voice state alongside `ScenarioExecutionState`: active adapter connections, the in-flight `VoiceTurnHandle`, the running recorder/timeline, the resolved voice config. Parks live voice state without polluting the text-centric `ScenarioExecutionState` and without a singleton. Created/destroyed within one `run()`. Does NOT compute final result types (`recording.types`), does NOT record bytes (`recording.runtime`).
**Public API (target):** `class VoiceExecutorState { constructor(config:ResolvedVoiceConfig); config; recorder; registerAdapter; adapters; setPendingTurn/pendingTurn; connectAll(); disconnectAll() }`.
**Boundary types:** Owns `VoiceExecutorState`. Consumes `ResolvedVoiceConfig`, `VoiceAgentAdapter`, `VoiceTurnHandle`, `Recorder`.
**As-built:** Exists as **2 forks** (Gap #4-adjacent): baseline / pr-538 (adds `interruptions` + `backgroundNoise` fields). The pr-538 fork references verbs (`voiceProceed`/`backgroundNoise`) that are implemented nowhere (Gap #8).
**Gap → action:** Merge the two forks (keep the pr-538 `interruptions`/`backgroundNoise` fields), and depends on `config.ts` existing (Gap #7) so its `ResolvedVoiceConfig` constructor arg is real. Plugs into `execution/scenario-execution-state` + `runner/run` — one per `run()`, connect at start, disconnect in `finally` (mirrors the isolated EventBus).

#### `voice/voice-models.ts`
**Responsibility:** Static data + lookups: model/voice → capabilities / routing — which judge models accept audio (gpt-4o, gemini-*-native-audio), default sample rates per platform, `"provider/x"` parse. One curated table vs. scattered checks. No network, no mutable state, does NOT define the capability type (`capabilities.ts`).
**Public API (target):** `parseProviderSpec(spec)`; `judgeModelCapability(model)`; `defaultSampleRateFor(platform)`; `AUDIO_CAPABLE_JUDGE_MODELS`.
**Boundary types:** Owns the model → capability/routing tables. Consumes `JudgeAudioCapability`.
**As-built:** Exists as **2 forks** (Gap #4-adjacent): baseline / pr-536 (adds the ElevenLabs + composable model constants — `EL_TTS=eleven_v3`, `EL_STT=scribe_v1`, `EL_VOICE_ID=...`, `COMPOSABLE_LLM=gpt-5.4-mini`).
**Gap → action:** Merge the two forks (keep the pr-536 constants). No interface change. The static tables are the right home for the EL/composable constants.

---

### Tier 7 — Recording & script steps

#### `voice/recording.types.ts`
**Responsibility:** The PUBLIC serializable result types on `ScenarioResult`: `VoiceRecording` (segments / duration / fullWav / `save()`), `AudioSegment`, the `VoiceEvent` timeline union, `LatencyMetrics`. Types only; the live recorder lives in `recording.runtime.ts`. The result surface is defined independently of the machinery. No recording / computing.
**Public API (target):** `AudioSegment`; `VoiceRecording`; `VoiceEvent` union (`user_start`/`stop_speaking`, `agent_start_speaking{latency?}`/`stop`, `user_interrupt`, `tool_call{name,args}`, `tool_result{name,result}`, `dtmf{tones}`, `silence{duration}`); `LatencyMeasurement`; `LatencyMetrics {avg/p50/p95ResponseTime, timeToFirstByte, interruptResponseTime, measurements}`.
**Boundary types:** Owns `VoiceRecording`, `AudioSegment`, `VoiceEvent`, `LatencyMetrics`, `LatencyMeasurement`. Consumes none.
**As-built:** Exists, **byte-identical from the merged #511 base** (Agent B).
**Gap → action:** As-built matches target — no change. (Field-ownership note: the host `ScenarioResult` gains additive optionals `audio?`/`timeline?`/`latency?` — module owns the types, host owns the fields. This type-owner-vs-field-owner split is A's closing-note risk #3.)

#### `voice/recording.runtime.ts`  (double-responsibility — OPEN DECISION)
**Responsibility:** The live recorder + the voice script-step factories. Recorder: ingest `AudioChunk`/`VadEvent` during the run, accumulate per-speaker segments, emit the `VoiceEvent` timeline, measure latency, produce `VoiceRecording`/`LatencyMetrics`. ALSO the home of `sleep`/`silence`/`audio`/`dtmf`/`interrupt` (each manipulates the live transport AND writes the timeline → it belongs by the recorder that owns the timeline). Does NOT define result types (`recording.types`), no provider/transport bytes (adapters).
**Public API (target):** `Recorder {onChunk(speaker,chunk); onVadEvent(speaker,e); onToolEvent(e); markUserInterrupt(time); timeline; buildRecording(); buildLatencyMetrics()}`; `createRecorder()`; steps `sleep(seconds)`/`silence(dur)`/`audio(source)`/`dtmf(tones)`/`interrupt({after?; afterWords?; content; voiceStyle?})` → `ScriptStep`.
**Boundary types:** Owns `Recorder`. Consumes `ScriptStep`, `AudioChunk`, `VadEvent`, the result types; reaches transport via `VoiceExecutorState` on the executor.
**As-built:** Recorder logic exists. But the **script steps are unhomed** (Gap #9): `interruption.ts` carries only the config, and there is no `voice/steps.ts` in the fixed tree, so `sleep`/`silence`/`audio`/`dtmf`/`interrupt` have no settled home. Re-implements `encodeWav` (one of four WAV dups). The fixed tree has no `steps.ts`; A deliberately bundled the steps here and flagged the resulting double-responsibility.
**Gap → action:** **Gap #9 — OPEN DECISION for review:** site the five script steps in a dedicated `voice/steps.ts` (cleaner SRP) **vs.** bundle them into `recording.runtime.ts` (A's choice — steps are coupled to the recorder/timeline, but the module then carries two responsibilities). Both A (closing-note #2) and B (Gap #9) flag this. Note `agent({wait})`/`proceed({interruptions})` are extensions of existing host steps via `adapter.runtime` + `interruption`, not new step files.

---

### Tier 8 — Adapters (one per platform)

#### `voice/adapters/composable.ts`
**Responsibility:** The BYO-protocol generic `WebSocketAgent`/`ComposableVoiceAgent` (PRD §5.7) — a user-supplied protocol (`encodeAudio`/`decodeResponse`) + a URL. A public extension point without subclassing. Owns the generic WS loop, delegates encoding. No vendor wire shape.
**Public API (target):** `VoiceProtocol {encodeAudio(audio):string|Uint8Array; decodeResponse(msg):AudioChunk}`; `ComposableVoiceAgentParams {url; protocol; audioFormat?; responseTimeout?}`; class + `composableAgent` factory.
**Boundary types:** Owns `VoiceProtocol`, `ComposableVoiceAgentParams`. Is an `AgentAdapter` via the base.
**As-built:** Exists (PR-536 territory). **Smell:** carries its own divergent copies of `STTProvider`, `ElevenLabsSTTProvider`, and `synthesize` (Gap #5) plus an inline ElevenLabs TTS path (Gap #10) and a fourth `pcm16ToWavBytes`. Wire: EL TTS `pcm_24000`; STT wraps WAV (Agent B wire-formats).
**Gap → action:** Gap #5 — de-dupe: import the canonical `SttProvider`/`synthesize` from `stt/` and `tts/` rather than redefining them. Gap #10 — the inline EL TTS is the thing the OPEN DECISION is about (promote to a leaf vs. keep it here).

#### `voice/adapters/pipecat.ts`
**Responsibility:** Leaf — Pipecat over WS (Twilio-style) or WebRTC (SmallWebRTC) (§4.1/§5.1). Owns the Pipecat framing + `audio_format`/`sample_rate`/`transport`/`signaling_url`. Client connect. No other platforms.
**Public API (target):** `PipecatAgentParams {url?; signalingUrl?; transport?; audioFormat?; sampleRate?; responseTimeout?}`; class + `pipecatAgent`.
**Boundary types:** Consumes the `VoiceAgentAdapter` base, codec helpers.
**As-built:** Exists (PR10/#540). Wire: μ-law/8k, dual-capability PCM16/24k + μ-law/8k, interrupt = clear-frame. **Imports the pr-540 codec** from `twilio-shared.ts` (Gap #6).
**Gap → action:** Gap #6 — `pipecat` is wire-locked to the pr-540 copy of `twilio-shared.ts` (codec fn named `mulaw8kToPcm16At24k`); reconcile to the single canonical `twilio-shared` and pick the canonical fn name. Otherwise matches target. `call()` reconciliation per Gap #11.

#### `voice/adapters/openai-realtime.ts`
**Responsibility:** Leaf — OpenAI Realtime, where the model IS the agent (§4.1/§5.6). Owns the Realtime WS event protocol + model/voice/instructions/tools/role; can be agent-under-test or (advanced) a realtime user-sim via role. Native `input_audio`/`audio` converted at the edge. No other vendors.
**Public API (target):** `OpenAIRealtimeAgentParams {model; voice?; instructions?; tools?; role?; apiKey?; responseTimeout?}`; class + `openAIRealtimeAgent`.
**Boundary types:** Consumes the `VoiceAgentAdapter` base.
**As-built:** Exists (PR8/#535, model `gpt-realtime-mini`). Wire: raw PCM16/24k, interrupt = `response.cancel`. **`call()` THROWS** (deferred to PR3) — a Gap #11 instance. Also the migration target for the legacy `realtime/` path → standardized `file` parts (§4.2).
**Gap → action:** Gap #11 — once `adapter.ts` is merged (Gap #4), settle `call()` so it uses the runtime default instead of throwing. Migrate the legacy `realtime/response-formatter.ts`/`message-processor.ts` `file`-part path here (§4.2). Convert native shapes at the edge only.

#### `voice/adapters/gemini-live.ts`
**Responsibility:** Leaf — Gemini Live native-audio, model-as-agent (§5.6). Owns the bidi protocol + model/voice/systemInstruction. Native shapes at the edge.
**Public API (target):** `GeminiLiveAgentParams {model; voice?; systemInstruction?; apiKey?; responseTimeout?}`; class + `geminiLiveAgent`.
**Boundary types:** Consumes the `VoiceAgentAdapter` base.
**As-built:** Exists (PR9/#534, model `gemini-2.5-flash-native-audio-latest`). Wire: PCM resampled in-16k/out-24k, `activityStart`/`End`, interrupt drains the queue. **`call()` returns `""`** — a Gap #11 instance.
**Gap → action:** Gap #11 — settle `call()` after the `adapter.ts` merge so it uses the runtime default rather than returning empty. Otherwise matches target.

#### `voice/adapters/elevenlabs.ts`
**Responsibility:** Leaf — the ElevenLabs ConvAI *transport* (§5.4): `agentId`/`apiKey`, PCM16 send/recv. Distinct from the ElevenLabs STT leaf (this is conversation transport, not transcription). No other vendors.
**Public API (target):** `ElevenLabsAgentParams {agentId; apiKey?; responseTimeout?}`; class + `elevenLabsAgent`.
**Boundary types:** Consumes the `VoiceAgentAdapter` base.
**As-built:** Exists (PR7/#536, "ElevenLabs adapter"). Wire: raw PCM16/24k + a 16000-byte silence tail (Agent B wire-formats).
**Gap → action:** No numbered gap of its own. `call()` reconciliation per Gap #11; otherwise matches target. (One-file-per-provider already satisfied.)

#### `voice/adapters/eleven-labs-voice-agent.ts`
**Responsibility:** (tree entry) The ElevenLabs ConvAI transport implementation. The fixed tree lists both `elevenlabs.ts` and `eleven-labs-voice-agent.ts`; A modeled the single ElevenLabs ConvAI transport contract (`elevenlabs.ts`) and did not separately contract this second filename.
**Public API (target):** Not separately contracted by A — folds into the `elevenLabsAgent` transport contract above.
**Boundary types:** As `elevenlabs.ts`.
**As-built:** Present as a tree filename (PR7/#536 territory) — the two ElevenLabs filenames are a naming artifact of the as-built layout, not two distinct responsibilities.
**Gap → action:** Consolidation note (not a numbered gap): collapse `elevenlabs.ts` + `eleven-labs-voice-agent.ts` into one transport file while building the fresh clean stack so there is a single ElevenLabs ConvAI adapter. Flag for review alongside the barrel cleanup.

#### `voice/adapters/twilio.ts`
**Responsibility:** Leaf — Twilio phone (§5.3). Owns the CLIENT-facing `TwilioAgent` + params (`phoneNumber`/`fromNumber`/`accountSid`/`authToken`), orchestrates the outbound call + consumes the Media Stream (μ-law/8kHz). Composes `twilio-server` (the Media Stream WS) + `twilio-tunnel` (ingress). Does NOT run the server / tunnel itself.
**Public API (target):** `TwilioAgentParams {phoneNumber; fromNumber?; accountSid?; authToken?; responseTimeout?}`; class + `twilioAgent`. Also consumes `TwilioMediaStreamServer`, `TwilioTunnel`.
**Boundary types:** Consumes the `VoiceAgentAdapter` base, `TwilioMediaStreamServer`, `TwilioTunnel`.
**As-built:** Exists (PR11/#539). Wire: μ-law/8k only, `dtmf:true` (the ONLY adapter advertising DTMF), `sendDtmf` via REST, `X-Twilio-Signature` validation. **Imports the pr-539 codec** from `twilio-shared.ts` (Gap #6).
**Gap → action:** Gap #6 — `twilio` is wire-locked to the pr-539 copy of `twilio-shared.ts` (codec fn named `..._24k`, plus REST + validation), which **diverges** from the pr-540 copy that pipecat uses. Reconcile to one `twilio-shared.ts`, pick canonical codec fn names. `call()` per Gap #11.

#### `voice/adapters/twilio-server.ts`
**Responsibility:** The local Twilio Media Stream WS server + the TwiML responder Twilio connects back to. Owns the inbound/outbound frame protocol (base64 μ-law, `start`/`media`/`stop`), exposes `AudioChunk` send/recv to `TwilioAgent`. Telephony inverts client/server roles → the SDK hosts the media endpoint. Does NOT place the call (`twilio.ts`) or expose publicly (`twilio-tunnel`).
**Public API (target):** `TwilioMediaStreamServer {start({port?}):Promise<{wsUrl;twimlUrl}>; sendAudio; recvAudio; stop}`; `createTwilioMediaStreamServer`.
**Boundary types:** Owns `TwilioMediaStreamServer`. Consumes `AudioChunk`, codec helpers.
**As-built:** Exists (PR11/#539 — media-stream server). Consumes the pr-539 `twilio-shared` codec (Gap #6).
**Gap → action:** Gap #6 — re-point at the reconciled canonical `twilio-shared`. Otherwise matches target.

#### `voice/adapters/twilio-tunnel.ts`
**Responsibility:** Expose the local media server publicly (ngrok-style) so the Twilio cloud reaches `twimlUrl`/`wsUrl`. Owns the tunnel lifecycle + URL rewrite. Isolates the infra concern. Does NOT serve media or place calls.
**Public API (target):** `TwilioTunnel {open(localPort):Promise<{publicUrl}>; close}`; `createTwilioTunnel({provider?; authToken?})`.
**Boundary types:** Owns `TwilioTunnel`. Consumes none (infra).
**As-built:** Exists (PR11/#539 — tunnel harness).
**Gap → action:** No numbered gap — matches target.

#### `voice/adapters/twilio-shared.ts`  (NOT in A's contract list — as-built artifact)
**Responsibility:** (as-built) Shared Twilio/telephony codec helpers (μ-law/8k ↔ PCM16/24k) plus, in one fork, REST + signature-validation helpers. A did NOT contract this file — A folded codec helpers behind the individual adapters; this is an as-built extraction surfaced by B.
**Public API (target):** None from A. As-built: μ-law↔PCM16 codec fns (divergently named) + (pr-539 fork) REST/validation.
**Boundary types:** As-built owns the codec fns; consumed by `pipecat`, `twilio`, `twilio-server`.
**As-built:** **2 DIVERGENT files at the same path** (Gap #6): the pr-540 copy is codec-only (`mulaw8kToPcm16At24k`); the pr-539 copy is codec + REST + validation with a **renamed** codec fn (`..._24k`). Pipecat is wire-locked to pr-540's; Twilio to pr-539's. A naive merge breaks one transport.
**Gap → action:** Gap #6 — reconcile to a single `twilio-shared.ts`, pick canonical codec fn names, and re-point both `pipecat` and the Twilio trio at it. Load-bearing contradiction (Agent B `consequence`).

#### `voice/adapters/pending-transport-error.ts`  (NOT in A's contract list — as-built artifact)
**Responsibility:** (as-built) A small error type for transports that are still connecting / not yet ready. A did not contract this; it is an as-built helper surfaced by the tree, consistent with the leaves that throw from `call()` before connect (Gap #11).
**Public API (target):** Not contracted by A.
**Boundary types:** As-built owns the error type; consumed by the transport leaves.
**As-built:** Present as a tree filename. Related to the Gap #11 "`call()` throws before PR3 wiring" pattern.
**Gap → action:** No numbered gap. Keep as a leaf helper; ensure it is the single error type the reconciled `call()` (Gap #11) raises for not-yet-connected transports.

#### `voice/adapters/index.ts`
**Responsibility:** Barrel re-exporting every adapter class + factory + protocol/param types. No logic, no instantiation.
**Public API (target):** re-export all adapter classes/factories + `VoiceProtocol`/param types.
**Boundary types:** none.
**As-built:** Exists per adapter PR; subject to the same per-PR divergence as the top-level barrel.
**Gap → action:** No numbered gap — append-only discipline in the re-stack (§5.1).

---

### Host-side edits (existing files — the seam attach points)

These are not `voice/` modules but are where the catalog's modules attach. A contracted them as host seams; B confirms they exist on main.

#### `domain/scenarios/index.ts` — `+field`
**Responsibility (delta):** `ScenarioConfig` gains `voice?: VoiceConfig` (module owns the type in `config.ts`, host owns the field). Also: `proceed()` widens to accept `interruptions?: InterruptionConfig`, and `agent()` widens to `{wait?: boolean}` (A's closing-note risk #1).
**As-built:** `ScenarioConfig` exists; the `voice` field is **not yet added** (depends on Gap #7). The `agent({wait})`/`proceed({interruptions})` widenings are referenced by pr-538 but the consuming machinery is unimplemented (Gap #8).
**Gap → action:** Add the additive field once `config.ts` lands (Gap #7); widen `agent`/`proceed` signatures to realize the interruption seam (Gap #8).

#### `execution/scenario-execution-state.ts` — `+fields`
**Responsibility (delta):** Absorbs the per-run recording/timeline/latency fields; hosts (or is paired with) `VoiceExecutorState`.
**As-built:** Exists on main; voice fields typed in `voice/voice-executor-state.ts` (which has 2 forks — merge per Gap #4-adjacent).
**Gap → action:** Merge the `voice-executor-state.ts` forks, then thread the per-run state in at run start / `finally` (§3.1).

#### `agents/judge/judge-agent.ts` & `judge-utils.ts` — `→ edit`
**Responsibility (delta):** Run the STT pass (`prepareJudgeInput` from `judge-stt.ts`) **before** `buildTranscriptFromMessages` (`judge-utils.ts:90`, which already truncates audio `file` parts to byte-markers).
**As-built:** `buildTranscriptFromMessages` exists and truncates audio parts. The pre-judge STT hook is net-new (§3.3 / §7.7); PR4/#528 models the correct "auto-transcribe → judge gets text" behavior. The PRD's `wrapJudgeForAudioTranscription` does **not** exist as a `src` library API — it ships only as a committed example helper at `javascript/examples/vitest/tests/helpers/`.
**Gap → action:** Wire `judge-stt.ts#prepareJudgeInput` in before line 90; do NOT add a "judge requests transcript" tool (no such tool — §7.3).

#### `agents/user-simulator-agent.ts` — `→ edit`
**Responsibility (delta):** On `call()` (role=USER), when `cfg.voice?.tts` (or a per-step `voice`/`audio_effects`) is set: LLM text → per-run TTS → effects → audio `ModelMessage`.
**As-built:** Exists on main; the voice-aware path is modeled by PR4/#528. Consumes the `tts.ts` cache (invariant preserved, §3.2).
**Gap → action:** Thread the per-run TTS provider (from `config.ts`, Gap #7) rather than a global; apply effects after the cache read.

#### `agents/realtime/` — `reconcile`
**Responsibility (delta):** Fold into `voice/adapters/openai-realtime.ts` + migrate to standardized `file` parts (§4.2).
**As-built:** `realtime/response-formatter.ts:22` + `realtime/message-processor.ts:21` already use AI-SDK `file` parts — this is the format the rest of the design standardizes on.
**Gap → action:** Migrate the realtime path into the OpenAI Realtime adapter; reuse its existing `file`-part handling as the canonical in-message format (helps resolve Gap #3).

#### `runner/run.ts` — `→ edit`
**Responsibility (delta):** Resolve voice config — fold any `RunOptions.voice` override into `cfg.voice` at the boundary (`options?.voice ?? cfg.voice ?? default`) so the carrier reaching `call()` is `cfg.voice` — and construct the per-run `VoiceExecutorState`.
**As-built:** Exists; voice resolution **absent** (depends on Gap #7).
**Gap → action:** Add the resolution + per-run state construction once `config.ts` (Gap #7) and the merged `voice-executor-state.ts` land.

#### `script/index.ts` — `+steps`
**Responsibility (delta):** Surface `sleep`/`silence`/`audio`/`interrupt`/`dtmf` as script steps.
**As-built:** Exists; the five voice steps are **unhomed** (Gap #9) — they live nowhere settled yet.
**Gap → action:** Gap #9 (OPEN DECISION) — wire whichever home wins (dedicated `voice/steps.ts` vs. `recording.runtime.ts`) through this barrel.

#### `config/configure.ts` — ⚠ `CHANGE`
**Responsibility (delta):** Remove the invented `configure({stt})`; `configure()` stays for global *execution* settings only.
**As-built:** Exists as a two-line `setSttProvider` if-block (Gap #2) — the invented API the PRD never specified.
**Gap → action:** Gap #2 — delete the `{stt}` path; route provider config to `run({ voice })`. Also strip `PR2 of issue #372`-style comments (§7.6) and rewrite the Python-syntax step strings `scenario.configure(stt=...)` to the TS object form (§7.5).

#### `index.ts` (top-level) — `exists`
**Responsibility (delta):** `export * as voice from "./voice"` — already namespaced, no flat-merge collision by design (§5.1).
**As-built:** Already correct on main.
**Gap → action:** No change. The per-PR `voice/index.ts` divergence is a *stacking* problem, not a top-level-barrel problem.

---

## 1. Stable seams voice plugs into

Voice does **not** introduce a parallel runtime. It hooks into four existing seams. All
`file:line` are on `main` / the base branch.

| Seam | Location | What voice does with it |
|---|---|---|
| **`AgentAdapter.call(input)`** | `domain/agents/index.ts:103` | The single integration point. `VoiceAgentAdapter extends AgentAdapter` (`voice/adapter.ts:35`) implements `call()`: extract audio from `input.newMessages`, send via transport, return a `ModelMessage` with audio + transcript. |
| **`AgentInput.scenarioConfig`** | `domain/agents/index.ts:63` → `domain/scenarios/index.ts:11` | Per-run config arrives in *every* `call()`. This is where voice provider config lives (§2). |
| **`ScenarioExecutionState`** | `execution/scenario-execution-state.ts:24` | Holds per-run message/turn state. Voice recording/timeline/latency accumulate here (§3, §4). `VoiceExecutorState` (`voice/voice-executor-state.ts:22`) already types these fields. |
| **`JudgeUtils.buildTranscriptFromMessages`** | `agents/judge/judge-utils.ts:90` | Already truncates audio `file` parts to byte-markers. The judge's STT pass hooks in *before* this, replacing audio parts with transcribed text (§3.3). |

**Design rule:** voice internals build on these four. Anything that doesn't fit one of them
is a smell — re-examine before adding a new global or a parallel path.

---

## 2. State model — everything is per-run

> **Rule: no process-wide mutable state. Provider/config state is scoped to one `run()`.**
> This is [ADR-001](../adr/001-scenario-concurrency-model.md) applied to voice. See
> ADR-002.

### 2.1 Provider config lives on `ScenarioConfig`

```ts
// domain/scenarios/index.ts — add:
interface ScenarioConfig {
  // ...existing...
  voice?: VoiceConfig;
}

interface VoiceConfig {
  stt?: STTProvider;        // default: OpenAISTTProvider (gpt-4o-transcribe), constructed per-run
  tts?: TtsConfig;          // provider + voice routing for the user simulator
  // include_audio / include_timeline / include_traces judge knobs live here too (PRD §4.3)
}
```

Resolution priority — the carrier that reaches `call()` is `cfg.voice`:

```
cfg.voice?.stt  ??  new OpenAISTTProvider()   // pure default, constructed per-run
```

An optional run-level knob (`RunOptions.voice`) may sit in front of it for a per-invocation
override, resolved at the `run()` boundary into `cfg.voice` before the scenario executes:

```
options?.voice?.stt  ??  cfg.voice?.stt  ??  new OpenAISTTProvider()
```

But note the asymmetry that drives the whole decision: `RunOptions` is consumed *at the
`run()` boundary and never reaches `call()`* (see `runner/run.ts:146` — `langwatch` is
resolved `options?.langwatch ?? env` and stops there). `ScenarioConfig` is the only per-run
object that arrives inside every `call()` (via `AgentInput.scenarioConfig`,
`domain/agents/index.ts:63`). So the provider that the judge and user-simulator read *inside*
`call()` must live on `cfg.voice` — `RunOptions.voice` can only seed it, it cannot be the
carrier.

### 2.2 What this replaces

| PR2 (#513) — remove | Replacement |
|---|---|
| `let provider` module global in `voice/stt.ts` | `cfg.voice?.stt`, resolved per-run |
| `setSttProvider()` / `getSttProvider()` | read `input.scenarioConfig.voice?.stt` in the consumer |
| `scenario.configure({ stt })` (invented) | `run({ voice: { stt } })` / `RunOptions.voice` |

### 2.3 Why `ScenarioConfig` is the right carrier (set on its own merits)

This is **not** a copy of the `langwatch` config pattern — and that distinction matters,
because `langwatch` would not work here:

- **`langwatch` lives on `RunOptions`, not `ScenarioConfig`.** It is resolved two-tier at the
  `run()` boundary — `options?.langwatch?.apiKey ?? env` (`runner/run.ts:146`) — and consumed
  there. It **never reaches `call()`**. A boundary-only carrier is fine for `langwatch`
  (telemetry config the runner reads once) but would be useless for voice: the STT provider
  has to be read *inside* `call()`.
- **The STT/TTS consumers run inside `call()`.** The judge's transcription pass and the user
  simulator's TTS pass both execute within an agent's `call()`. The only per-run object that
  arrives in every `call()` is `AgentInput.scenarioConfig` (`domain/agents/index.ts:63`,
  threading into the abstract `call()` at `:103`). Therefore the provider **must** ride on
  `ScenarioConfig.voice` — it is the sole per-run carrier that reaches the consumers. A
  `RunOptions.voice` knob can seed it at the boundary, but cannot replace it.
- **`createLLMInvoker`** (`agents/llm-invoker.factory.ts:12`) is the genuine in-repo
  precedent for the *no-global* principle: the LLM provider is resolved per-call from merged
  config (`modelSchema.parse({...projectConfig?.defaultModel, ...cfg})`), **never from a
  global registry**. The voice global was the odd one out; per-run state aligns it. (This is
  the principle we share — not the `langwatch`/`RunOptions` resolution mechanism, which is
  boundary-only by design.)

---

## 3. Lifecycle ownership

### 3.1 Adapter connect/disconnect

The executor owns adapter lifecycle (PRD §4.1: "executor automatically calls `connect()`…
`disconnect()`"). `VoiceAgentAdapter` already declares `connect`/`disconnect`/`sendAudio`/
`receiveAudio`/`interrupt` (`voice/adapter.ts`). `ScenarioExecution` calls `connect()` for
voice adapters at run start and `disconnect()` in a `finally` at run end — no manual
lifecycle in user code.

### 3.2 User simulator TTS (per-run)

`UserSimulatorAgentAdapter.call()` (role=USER): when `cfg.voice?.tts` (or per-step
`voice`/`audio_effects`) is set, generate text via LLM → synthesize via the per-run TTS
provider → apply effects → return an audio `ModelMessage`. The TTS LRU cache (`tts.ts`) is
keyed on `sha256(text)+voice`, **not** on provider identity — effects apply *after* cache
read, so raw text never enters the payload. (This is the one piece of PR2 worth keeping
as-is; the cache invariant is correct and tested.)

### 3.3 Judge STT pass (per-run) — net-new, NOT "extend existing"

> **PRD correction:** the PRD says "extend existing `wrapJudgeForAudioTranscription`". That
> function **does not exist as a `src` library API** — it ships as a committed *example*
> helper at `javascript/examples/vitest/tests/helpers/` (`wrap-judge-for-audio-transcription.ts`),
> not as something the framework exports. The judge transcription pass is net-new in `src`.

Hook point: in `JudgeAgentAdapter.call()`, **before** `buildTranscriptFromMessages`
(`judge-utils.ts:90`), run an STT pass over any `file`/audio content parts using
`input.scenarioConfig.voice?.stt`, replacing each with `{ type: "text", text: transcript }`.
The judge then sees text (and, for multimodal judge models, optionally the raw audio per PRD
§4.3 `include_audio`).

> **PRD/test correction:** the judge does **not** "request a transcript." STT is automatic
> and upstream; the judge's tools are `continue_test`, `finish_test`, and (conditionally)
> `expand_trace`/`grep_trace` (`judge-agent.ts:254`). Any test step named "the judge
> requests a transcript" encodes a non-existent behavior and must be rewritten to "audio is
> auto-transcribed and the judge receives text" (which is what PR4/#528 actually models).

---

## 4. Data model

### 4.1 Internal canonical format

`AudioChunk` (`voice/audio-chunk.ts`) — PCM16 LE, 24kHz mono, optional
`transcript`/`startTime`/`endTime`. This is the framework-boundary type; adapters convert
to/from transport-native (μ-law/8kHz for Twilio, etc.) at the send/recv edge.

### 4.2 The format split the PRD glosses over

> **PRD correction:** PRD Phase 1 says "standardize the existing `file` content parts" as if
> one format exists. Two do:
>
> - **AI-SDK `file` parts** — `{ type: "file", mediaType: "audio/pcm16", data }` — used by
>   the existing `RealtimeAgentAdapter` (`realtime/response-formatter.ts:22`,
>   `realtime/message-processor.ts:21`).
> - **OpenAI-convention parts** — `input_audio` / `audio` — defined in the merged #511 base
>   `voice/messages.types.ts`, not yet wired in.
>
> **Decision needed (this doc proposes):** standardize on the **AI-SDK `file` part** as the
> in-message representation (it's what the runtime + `buildTranscriptFromMessages` already
> handle), and treat the OpenAI `input_audio`/`audio` shapes as *adapter-edge* conversions
> only. Migrate `voice/messages.types.ts` consumers accordingly. This avoids two audio
> message formats flowing through the execution loop.

### 4.3 Result accumulation

`ScenarioResult` gains `audio` (`VoiceRecording`), `timeline` (`VoiceEvent[]`),
`latency` (`LatencyMetrics`) per PRD §4.6. These accumulate on `ScenarioExecutionState`
during the run (fields already typed in `voice/voice-executor-state.ts`) and are attached in
`ScenarioExecution.setResult()`. Existing `ScenarioResult` fields are unchanged.

---

## 5. Public-vs-internal seam

### 5.1 Barrel ownership (kills the collision)

The top-level barrel already does the right thing (`index.ts`):

```ts
export * as voice from "./voice";   // namespaced — NOT flat-merged into `scenario`
```

`voice` is a **namespace**, unlike runner/script/agents which flat-merge into the `scenario`
object. The 3-way `voice/index.ts` collision in the PR series is **not** a barrel-design
problem — it's purely that the PRs are flat siblings each editing the same file. The fresh
clean stack (§6) removes it: each clean-stack layer adds its exports on top of the previous
layer's `voice/index.ts` (the salvaged siblings are then closed).

**Rule: `voice/index.ts` has one owner per stacked PR** — the PR that introduces a module
adds its export line; downstream PRs append. No PR rewrites the barrel.

### 5.2 Public surface

Public (exported from `voice` namespace + the per-run config): `VoiceAgentAdapter`, the
platform adapter classes (`PipecatAgent`, etc.), `run({ voice })`, `AudioChunk`,
`VoiceRecording`/`VoiceEvent`/`LatencyMetrics`, the script steps (`sleep`/`silence`/`audio`/
`interrupt`/`dtmf`).

Internal (not exported, no stability promise): the STT/TTS provider *implementations*, the
judge STT-pass wrapper, the effects pipeline internals, transport codecs.

Removed from public surface: `setSttProvider`, `getSttProvider`, `scenario.configure({stt})`.

### 5.3 Provider file layout

Per the review note "each provider should its own file" and the PRD's own per-platform-class
philosophy (§4.1, "PipecatAgent means test my Pipecat agent" — explicitly rejecting a unified
router): **one file per provider**.

```
voice/
  stt/
    index.ts            ← barrel
    stt-provider.ts     ← STTProvider interface + resolve-from-config helper
    openai-stt.ts       ← OpenAISTTProvider
    elevenlabs-stt.ts   ← ElevenLabsSTTProvider
  tts/
    index.ts
    tts.ts              ← synthesize() + LRU cache (cache invariant preserved)
    openai-tts.ts
  ...
```

This matches Python's *intent* better than Python's *current layout* (Python co-locates both
STT providers in `stt.py`); we improve on the port rather than replicate its cramping.

---

## 6. PR → design map (the fresh clean stack)

**#511 (PR1) is MERGED** (squash `9216d35` → `main`, 2026-05-21); its contract surface
(the `AgentInput.scenarioConfig` surface, the voice contract types, the wrap-judge EXAMPLE
helpers) is now **part of base**. The fresh clean stack builds **ON** it — it does **not**
recreate it.

**Execution model — fresh clean stack, salvage-then-close (decided):** the remaining 10 PRs
(#513, #515, #528, #534–#540) are **flat siblings** off `feature/372-voice-ts-parity`
(all forked at `c247f42`; verified PR3/#515 and PR4/#528 do **not** contain PR2/#513's
commits). We are **not** rebasing them into a chain. Instead we **build a fresh, clean
dependency stack against current `main` (`c8cca4e`)**, salvaging each sibling's code as a
**reference source**, and **close the 10 siblings** once the clean stack lands. Each layer of
the clean stack consumes the real contract its predecessor (and the merged #511 base) defines.

The table below is the **code-salvage map**: which sibling PR's code maps to which EDR module.
These are **salvage sources, not branches to preserve** — the "consumes" column gives the
build order for the *new* clean stack, not a chain of the old siblings.

| Salvage source (PR) | Title | PRD phase | EDR section it implements | Clean-stack layer consumes | Notes / corrections |
|---|---|---|---|---|---|
| #511 (PR1) — **MERGED into base** | types-only contract surface | 1 | §4.1 types | — (in base, squash `9216d35`) | Already on `main`; the clean stack builds on it, does not recreate it |
| #513 (PR2) | TTS + STT plumbing | 1 | §2 (provider state), §3.2 (TTS), §3.3 (judge STT) | base (merged #511) | **Salvage + rework:** drop global + `configure({stt})`; provider per-run; fix invented test steps/tags |
| #515 (PR3) | adapter runtime + executor wiring + VAD | 1–2 | §1 (`call()` impl), §3.1 (lifecycle) | the #513-derived layer | salvaged code currently can't see `stt.ts` — clean stack layers it on the provider layer |
| #528 (PR4) | voice-aware simulator + judge + audio msgs | 1 | §3.2, §3.3, §4.2 | the #515-derived layer | models "audio auto-transcribed → judge gets text" (the correct judge behavior) |
| #538 (PR5) | script steps + interruption + result ext | 3, 5 | §4.3 (result), script DSL | the #528-derived layer | — |
| #537 (PR6) | effects module + noise assets | 4 | §3.2 effects | the #528/#538-derived layer | — |
| #536 (PR7) | ElevenLabs adapter | 2 | §5.3 provider file | the #515-derived layer | one-file-per-provider |
| #535 (PR8) | OpenAI Realtime adapter | 2 | §1, §4.2 | the #515-derived layer | also migrates realtime to standardized `file` parts (§4.2) |
| #534 (PR9) | Gemini Live adapter | 2 | §1 | the #515-derived layer | — |
| #540 (PR10) | Pipecat + g711 codec | 2 | §1, codecs | the #515-derived layer | — |
| #539 (PR11) | Twilio adapter + tunnel harness | 2 | §1, telephony | the #540-derived layer | — |

**The 10 open siblings get CLOSED.** Once the fresh clean stack lands on `main`, PRs #513,
#515, #528, #534, #535, #536, #537, #538, #539, and #540 are **closed** — their value was the
code, which is salvaged into the clean stack; the branches themselves are not preserved.

Two viable shapes for the clean stack (decide in review):

- **(A) Granular clean stack:** one clean PR per EDR layer, each branching off the previous,
  all rooted at current `main` (`c8cca4e`). Highest review granularity; salvages each
  sibling's code into its corresponding layer.
- **(B) Collapse the foundation:** fold the provider/runtime/simulator layers (salvaged from
  #513 + #515 + #528) into one coherent "voice core" clean PR — they share the same contracts
  — then layer the leaf adapters (salvaged from #536–#540) as a thin stack on top. Fewer PRs,
  one design review of the core.

Either way the base is current `main` (with the merged #511 in it), the siblings are salvage
sources that get closed, and this doc's design is the same. (B) trades PR granularity for a
single coherent core review.

---

## 7. Design corrections (summary)

Surfaced while mapping seams; each is actionable:

1. **Global STT provider** → per-run `ScenarioConfig.voice.stt` (ADR-002). Violated ADR-001.
2. **`scenario.configure({stt})`** → removed; use `run({ voice })`. Invented; in no PR, not
   in Python.
3. **"Judge requests a transcript"** → "audio auto-transcribed; judge receives text." No
   such judge tool exists.
4. **`@ts-stt` tag mismatch** → STT scenarios in `specs/voice-agents.feature` are tagged
   `@unit`, but `stt.test.ts` filters `includeTags: ["ts-stt"]` → binds nothing. Align tags.
5. **Python-syntax step strings** (`scenario.configure(stt=...)`) → rewrite as TS object
   form, and drop the reference to the removed API.
6. **PR-reference comments in source** (`PR2 of issue #372`) → strip.
7. **`wrapJudgeForAudioTranscription` "exists" as a library API** → it doesn't; it ships only as a committed example helper at `javascript/examples/vitest/tests/helpers/`. The judge STT pass is net-new in `src`.
8. **Single audio format assumption — LIVE BUG, not just drift.** Two in-message formats
   ship today: `messages.ts` emits WAV tagged `format:"wav"`, while `adapter.runtime.ts`
   emits raw PCM16 tagged `format:"pcm16"`. Their paired extractors decode by the tag, so
   **incompatible producers + extractors mis-decode**: cross-feeding one producer's message
   to the other's extractor reads a WAV header as audio samples (garbled audio / transcript).
   This is a real correctness defect (Gap #3), not stylistic divergence — **it must be fixed
   during format standardization**, not deferred. Standardize on the AI-SDK `file` part
   in-message with a single encoder + single extractor; OpenAI `input_audio`/`audio` shapes
   stay at the adapter edge only (§4.2). The §8 `@ts-e2e` round-trip assertion is the guard
   that this stays fixed.

### 7.1 Two tree decisions surfaced by the as-built extraction — RESOLVED

The as-built pass (Agent B) forced two layout decisions the locked tree did not settle. Both are reversible implementation calls; resolved here so the team has no open questions:

- **(a) Where the voice script steps live → DECIDED: dedicated `voice/steps.ts`.** `sleep`/`silence`/`audio`/`dtmf`/`interrupt` get their own module rather than bundling into `recording.runtime.ts`. Rationale: A's bundling was flagged for a double-responsibility (recorder + step factories); a `steps.ts` leaf keeps the recorder single-purpose and the steps discoverable. The steps depend on the recorder + executor via the `ScriptStep (state, executor) => …` signature, not by co-location. Add `voice/steps.ts` to the tree (§0); it imports from `recording.runtime.ts` (timeline writes) + `adapter.runtime.ts` (transport). See Gap #9. *(Reversible; if it proves too thin, fold back later.)*
- **(b) TTS provider asymmetry → DECIDED: add `voice/tts/elevenlabs-tts.ts` leaf.** Symmetric with `stt/elevenlabs-stt.ts`, satisfies the PRD's `elevenlabs/rachel` headline, and makes `voice="elevenlabs/..."` resolve through the `TtsProvider` registry instead of being buried in `adapters/composable.ts`. The composable adapter's inline EL-TTS is then de-duplicated to consume this leaf (folds into Gap #5). See Gap #10. *(The leaf is trivial and the cleaner shape; chosen over composable-only.)*


### 7.2 Accepted obligations (recorded from the devil's-advocate pass)

A challenge was run on "full EDR vs. just merge + fix the live bug + ship." The decision is **full EDR as designed** — taken deliberately, choosing internal quality over raw time-to-ship. Two costs of that choice are accepted, not free, and are tracked here:

- **TS/Python divergence → a Python parity follow-up is OWED.** This redesign makes the TS internals correct (per-run state, no global) while Python still carries the module-global provider + the phantom `configure(stt=…)` docstring. #372 was framed as *parity*; fixing only TS creates divergence. **Obligation:** file a follow-up issue to bring the Python SDK to this corrected design — parity on the right design, not on the bug. Do not close #372's epic without it.
- **Agent-authored contracts → mitigated, not eliminated.** §0.1's ~40 module signatures were produced by agents and will be the spec a team builds to. Mitigations in force: (1) the pre-commit re-verification pass against current HEAD; (2) human review of this PDF before commit; (3) the §8 runnable e2e gate, which catches contract errors at integration regardless of who authored them.
---

## 8. Verification target — the runnable top-of-stack

> **"Done" for #372 is not "11 PRs each passed their own tests." It is: check out the top of
> the stack and run a real voice scenario end-to-end, green.**

The top-of-stack must run the PRD's own §6 examples against a real (or harnessed) voice
agent — at minimum §6.1 (basic voice conversation) and §6.2 (interruption handling) — from a
single checkout, producing a saved `result.audio` and `result.latency`. That is the artifact
a human checks out to confirm the system fits this design, rather than diffing 11 PRs.

A `@ts-e2e`-tagged scenario bound at the top of the stack, exercising user-sim TTS →
transport → agent → judge STT → verdict, is the gate.

**The `@ts-e2e` gate must include a round-trip audio assertion.** Drive a known utterance through user-sim TTS → message bus → adapter → judge STT and assert the transcript on the far side matches the input text (within a tolerance). This is the regression guard for the Gap #3 **LIVE BUG**: because the two producers tag audio differently (`format:"wav"` vs. `format:"pcm16"`) and their extractors decode by tag, a format mismatch surfaces as a garbled transcript — which this assertion catches, where per-PR unit tests (each exercising only its own producer/extractor pair) do not.
