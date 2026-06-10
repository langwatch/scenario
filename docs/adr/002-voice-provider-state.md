# ADR-002: Voice Provider State — Per-Run, Not Global

**Date:** 2026-05-26

**Status:** Proposed

**Committed at:** repo-root `docs/adr/002-voice-provider-state.md` (alongside ADR-001 at `docs/adr/001-scenario-concurrency-model.md`; not under `javascript/docs/`).

## Context

The voice feature (#372) introduces STT (speech-to-text) and TTS (text-to-speech)
providers that the framework must select and configure. The PR2 implementation (#513)
installed these as **module-global singletons**:

```ts
// javascript/src/voice/stt.ts (PR #513)
let provider: STTProvider | null = new OpenAISTTProvider();
export function setSttProvider(p: STTProvider | null): void { provider = p; }
export function getSttProvider(): STTProvider | null { return provider; }
```

This is a faithful port of the Python implementation (`python/scenario/voice/stt.py`),
which uses the same module-global `_provider` + `set_stt_provider()`/`get_stt_provider()`.

**The problem:** process-wide mutable provider state is not safe under concurrent runs.
Two scenarios running in parallel with different STT providers clobber each other's
global — the last `setSttProvider()` wins for both. This is the exact failure mode
[ADR-001](./001-scenario-concurrency-model.md) was written to eliminate for LangWatch
config:

> *"Because environment variables are process-wide shared state, concurrent `run()` calls
> would overwrite each other's config… We will use per-call programmatic configuration…
> **No process-wide state mutation.** Config flows through function arguments."*

The voice global directly contradicts an already-accepted decision. The LangWatch
platform orchestrates batch scenario runs for multiple projects simultaneously, so
concurrency safety is a hard requirement, not a hypothetical.

Two further defects in the PR2 surface compound this:

- **`scenario.configure({ stt })` is invented.** Python's `configure()` has no `stt=`
  parameter; the real Python API is the standalone `set_stt_provider()`. The PRD's
  `scenario.configure(...)` is for global execution settings (`audio_playback=True`),
  not provider injection. No sibling PR (#515, #528, #537, #538…) implements
  `configure({stt})` either. It exists only in PR2's own tests.
- The judge does not "request a transcript." STT runs automatically upstream; the judge
  receives text. (Tests in #513 encode a `the judge requests a transcript` step that
  matches no judge tool — the judge's tools are `expand_trace`/`grep_trace` only.)

## Decision

Voice provider configuration is **per-run**, carried on `ScenarioConfig`. This is decided on
its own merits, **not** by analogy to `langwatch` config — and the difference is the whole
point:

```ts
interface ScenarioConfig {
  // ...existing fields...
  voice?: VoiceConfig;   // { stt?: STTProvider; tts?: TtsConfig; ... }
}
```

`ScenarioConfig` is the per-scenario object that threads into **every** agent's `call()` via
`AgentInput.scenarioConfig` (`domain/agents/index.ts:63`, into the abstract `call()` at
`:103`). The STT provider must be read by the judge (transcription pass) and the user
simulator (TTS) — both of which run **inside `call()`** — so the provider has to live on the
one per-run carrier that reaches them. That carrier is `ScenarioConfig.voice`.

`RunOptions` does **not** qualify: it is consumed at the `run()` boundary and never reaches
`call()`. (`langwatch` config, for contrast, lives on `RunOptions` — `runner/run.ts:42` — and
is resolved two-tier and boundary-only, `options?.langwatch?.apiKey ?? env` at
`runner/run.ts:146`. That model works for telemetry config the runner reads once; it would
**not** work for voice, whose consumers are inside `call()`. So we are *setting* this pattern
on its merits, not mirroring `langwatch`.)

Resolution priority — the carrier that reaches `call()` is `cfg.voice`:

```
cfg.voice?.stt  ??  <default OpenAI provider>
```

An optional `RunOptions.voice` run-level knob may seed `cfg.voice` at the boundary
(`options?.voice ?? cfg.voice ?? default`), but the object the consumers read is always
`cfg.voice`.

The resolved provider is read inside the consumer (the judge's transcription pass, the
user simulator's TTS pass) from `input.scenarioConfig.voice`, which already arrives in
every `AgentAdapter.call()` via `AgentInput.scenarioConfig`. No module-global, no
`setSttProvider()`, no `scenario.configure({stt})`.

The default provider (OpenAI `gpt-4o-transcribe`) is constructed per-run when `voice.stt`
is unset — a pure default, not shared mutable state.

`scenario.configure({stt})` is removed from the public surface. STT/TTS providers are
configured per-run via `run({ voice: { stt } })` (or `RunOptions`), not globally.

## Consequences

- **Concurrent runs are isolated.** Each run resolves its own provider from its own
  config. Parallel scenarios with different providers no longer clobber each other.
- **Consistent with ADR-001's no-global principle.** Voice config flows through function
  arguments rather than process-wide state — the same principle ADR-001 set. (The carrier
  differs from `langwatch`: `langwatch` rides `RunOptions` and is read only at the `run()`
  boundary, whereas voice must ride `ScenarioConfig` because its consumers run inside
  `call()`. Same principle, correct carrier for the job.)
- **No global mutable state.** Matches the existing `createLLMInvoker` precedent — the LLM
  provider is resolved per-call from merged config, never from a global registry.
- **Public API shrinks and de-invents.** `setSttProvider`/`getSttProvider`/`configure({stt})`
  go away in favor of `run({ voice })`. Closer to "a voice test is just a scenario test."
- **Python carries the same debt.** Python's module-global `_provider` has the identical
  concurrency bug and a docstring advertising a `configure(stt=…)` wiring that was never
  built. A follow-up issue should bring Python to this corrected design for true parity —
  parity on the *right* design, not parity on the bug.
- **Per-run default construction** has a negligible cost (one provider object per run);
  the LRU cache in `tts.ts` is keyed on content, not on provider identity, so caching is
  unaffected.

## Alternatives considered

- **Keep the global (faithful Python parity).** Rejected: it ports a concurrency bug and
  violates ADR-001. Parity is not a defense when the thing being matched is wrong.
- **A provider registry class (instance, but still one per process).** Rejected: addresses
  the "standalone get/set is ugly" critique but not the concurrency one — a single
  process-wide instance still clobbers across parallel runs. `ScenarioConfig.voice` solves
  both.
- **Thread provider as an explicit argument through every call site.** Rejected: that's
  what `ScenarioConfig` already is — the per-run argument bag. Adding a parallel mechanism
  duplicates it.
