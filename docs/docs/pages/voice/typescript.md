# Voice testing in Scenario (TypeScript) — see the published docs

> **This stopgap guide has been folded into the published documentation.**
> The voice docs now carry the TypeScript view inline, alongside Python, in
> language tabs (`:::code-group` / `<LanguageTabs>`) — there is no longer a
> separate TS-only guide to keep in sync. This page is a thin pointer kept only
> so existing in-repo links don't break.

A voice test is just a Scenario test: same `scenario.run()`, same script DSL,
same judge — only the medium changes (audio instead of text). You make a test a
voice test by passing voice-capable agents. There is no `scenario.voice.run()`.

```ts
import scenario, { userSimulatorAgent, judgeAgent } from "@langwatch/scenario";

const result = await scenario.run({
  name: "billing dispute - angry customer",
  description:
    "Customer calls angry about a double charge; agent should de-escalate",
  agents: [
    scenario.pipecatAgent({ url: "ws://localhost:8765/ws" }),
    userSimulatorAgent({ voice: "openai/nova" }),
    judgeAgent({
      criteria: ["Agent remains calm and offers a concrete resolution"],
    }),
  ],
  script: [
    scenario.user("I just got charged TWICE, what the hell?"),
    scenario.agent(),
    scenario.user(),
    scenario.agent(),
    scenario.judge(),
  ],
});

expect(result.success).toBe(true);
```

## Where everything moved (published voice docs)

Each page below shows Python **and** TypeScript in language tabs:

- **Getting started** — install, env, your first voice scenario, adapter swap:
  [`/voice/getting-started`](/voice/getting-started).
- **How to choose an adapter** — per-use-case picker, with the per-adapter
  language availability: [`/voice/choosing-an-adapter`](/voice/choosing-an-adapter).
- **Adapters** — constructor + capabilities + worked examples per adapter:
  [Pipecat](/voice/adapters/pipecat), [Twilio](/voice/adapters/twilio),
  [OpenAI Realtime](/voice/adapters/openai-realtime),
  [Gemini Live](/voice/adapters/gemini-live),
  [ElevenLabs](/voice/adapters/elevenlabs),
  [Composable](/voice/adapters/composable).
  (LiveKit, Vapi, generic WebRTC, and generic WebSocket are **Python-only** for
  now — tracked in [#563](https://github.com/langwatch/scenario/issues/563).)
- **Recipes** — task patterns in both languages:
  [Interruptions](/voice/recipes/interrupt),
  [Multi-turn](/voice/recipes/multi-turn),
  [Audio effects](/voice/recipes/effects),
  [Observability](/voice/recipes/observability).
- **Capability matrix** — per-adapter features, with a TypeScript tab/column:
  [`/voice/capability-matrix`](/voice/capability-matrix).
- **Troubleshooting** — common failures, with TS-aware notes (VAD fallback,
  ffmpeg, recordings): [`/voice/troubleshooting`](/voice/troubleshooting).

## TypeScript surface — quick reference

The shipped TS surface (grounded against `javascript/src/` and
`javascript/examples/vitest/tests/voice/`):

- **Entry point:** `scenario.run(cfg, options?)`. Per-run voice/STT/TTS config is
  the **second argument** — `scenario.run(cfg, { voice: { stt, tts, includeAudio,
  includeTimeline, includeTraces } })` (ADR-002; this replaced the removed global
  `configure(stt=...)`). Live hooks `onAudioChunk` / `onVoiceEvent` go on `cfg`.
- **Adapter factories** (on the `scenario` object): `pipecatAgent`,
  `twilioAgent`, `openAIRealtimeAgent`, `geminiLiveAgent`, `elevenLabsAgent`,
  `composableAgent`. Class forms live under the `voice` namespace
  (`voice.PipecatAgentAdapter`, …) for `extends`/`instanceof`, plus the
  provider-branded preset `new voice.ElevenLabsVoiceAgent({ apiKey })`.
- **User simulator / judge:** `userSimulatorAgent({ voice, persona, audioEffects,
  interruptProbability })`; `judgeAgent({ criteria, includeAudio?, includeTimeline?,
  includeTraces? })` (auto-detects audio).
- **Script steps:** `scenario.sleep(seconds)`, `scenario.silence(duration)`,
  `scenario.audio(pathOrBytes)`, `scenario.dtmf(tones)`,
  `scenario.interrupt({ after | afterWords | content })`,
  `scenario.agent({ wait: false })` (non-blocking; alias `scenario.voiceAgent`),
  `scenario.voiceProceed({ turns, interruptions })` with
  `new voice.InterruptionConfig({ probability, delayRange, strategy })`.
- **Effects** (`voice.effects`, camelCase): `backgroundNoise`, `phoneQuality`,
  `packetLoss`, `lowVolume`, `highVolume`, `static_`, `echo`, `robotic`,
  `breakingUp`, `multipleVoices`, `lowQuality`, `speakingFast`, `speakingSlow`,
  `custom`. (Pick an accented TTS voice for accents — there is no `accent` effect.)
- **Results:** `result.success` / `metCriteria` / `unmetCriteria` / `reasoning`
  (unchanged), plus voice fields `result.audio` (`VoiceRecording`, with
  `.save(path)` / `.saveSegments(dir)`), `result.timeline` (`VoiceEvent[]`),
  `result.latency` (`LatencyMetrics`: `timeToFirstByte`, `avgResponseTime`,
  `p50ResponseTime`, `p95ResponseTime`, `interruptResponseTime`).
- **Twilio tunnel:** `voice.openTwilioTunnel({ port })` → pass `tunnel.url` as
  `publicBaseUrl`.

## See also

- **Capability matrix (TypeScript)** — per-adapter features, wire formats, and the
  errors that reference them:
  [`javascript/docs/voice/capability-matrix.md`](../../javascript/docs/voice/capability-matrix.md).
- **Recorded demos (audio evidence)** — `full.wav` + `manifest.json` per `@e2e`
  demo: [`javascript/recordings/README.md`](../../javascript/recordings/README.md).
- **Internal design (EDR)** — how the voice subsystem is built:
  [`docs/voice/internal-design.md`](./internal-design.md).
- **Python parity** — the same surface in Python:
  [`docs/voice/capability-matrix.md`](./capability-matrix.md),
  [`docs/voice/happy-path-elevenlabs.md`](./happy-path-elevenlabs.md),
  [`docs/voice/happy-path-openai-realtime.md`](./happy-path-openai-realtime.md).
