# Voice testing in Scenario (TypeScript)

> Audience: a TypeScript/JavaScript developer who tests AI agents with
> `@langwatch/scenario` and wants to test a **voice** agent — same
> `scenario.run()`, same script DSL, same judge, only the medium changes.
>
> Every API shown here is grounded against the shipped TS surface
> (`javascript/src/index.ts`, `javascript/src/voice/`,
> `javascript/src/script/voice-steps.ts`, `javascript/src/runner/run.ts`). Where
> the TS idiom differs from the Python design proposal (PRD §9 mirrors Python
> with camelCase), the **real TS name is used** and the difference is called out.

---

## A voice test is just a Scenario test

Same `scenario.run()`, same script DSL, same judge criteria. The only thing that
changes is the medium — audio instead of text. You make a test a voice test by
passing voice-capable agents. There is no `scenario.voice.run()` and no separate
paradigm.

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
      criteria: [
        "Agent remains calm and professional despite the angry tone",
        "Agent acknowledges the customer's frustration before problem-solving",
        "Agent offers a concrete resolution (refund, credit, or escalation)",
      ],
    }),
  ],
  script: [
    scenario.user(
      "Yeah hi, I just got charged TWICE for my subscription, what the hell?",
    ),
    scenario.agent(),
    scenario.user(),
    scenario.agent(),
    scenario.judge(),
  ],
});

expect(result.success).toBe(true);
```

The only differences from a text test: `scenario.pipecatAgent({ url })` instead of
your text agent, and `voice: "openai/nova"` on the user simulator. Everything else
is identical.

> **Two surfaces, both public.** The voice agent adapters ship as **factory
> functions on the `scenario` object** — `scenario.pipecatAgent({...})`,
> `scenario.openAIRealtimeAgent({...})`, etc. (the PRD §9 idiom). The same
> adapters are also exported as **classes under the `voice` namespace** —
> `new voice.PipecatAgentAdapter({...})` — for `extends`/`instanceof`. Use the
> factory for the common case; reach for the class when you subclass or
> type-narrow. `userSimulatorAgent`, `judgeAgent`, and the script steps
> (`scenario.user`, `scenario.agent`, …) are lowercase functions either way.

---

## What changes vs. text — and what doesn't

**Changes:** voice agent adapter factories/classes; `userSimulatorAgent` gains a
`voice` option; `judgeAgent` auto-detects audio; new script steps (`interrupt`,
`dtmf`, `audio`, `silence`, `sleep`, plus the non-blocking `agent({ wait: false })`
turn — also exported as the alias `voiceAgent({ wait: false })`); `result` gains
`audio`/`timeline`/`latency`; per-run config via `run({ voice })`.

**Stays the same:** the `scenario.run()` signature; the script step model;
`scenario.user`, `scenario.agent`, `scenario.judge`, `scenario.proceed`,
`scenario.succeed`, `scenario.fail`, `scenario.message`; the `AgentAdapter`
interface; criteria-based judgment; turn counting and `maxTurns`; caching; events
and LangWatch integration.

---

## 1. Voice agent adapters

Each adapter extends `voice.VoiceAgentAdapter` and handles its platform's
connection. The executor calls `connect()` when the scenario starts and
`disconnect()` when it ends — no manual lifecycle in your code.

```ts
import scenario, { voice } from "@langwatch/scenario";

// ── Framework agents (connect to YOUR running agent) ──────────────

// Pipecat over WebSocket (Twilio-style bidirectional stream).
// Defaults: transport "websocket", audioFormat "mulaw", sampleRate 8000.
scenario.pipecatAgent({
  url: "ws://localhost:8765/ws",
  audioFormat: "mulaw", // or "pcm16"
  sampleRate: 8000, // match your agent's config
});

// Pipecat over WebRTC — transport stubbed; raises PendingTransportError today.
scenario.pipecatAgent({
  signalingUrl: "http://localhost:7860/api/offer",
  transport: "webrtc",
});

// ── Phone testing ─────────────────────────────────────────────────

scenario.twilioAgent({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  phoneNumber: "+14155551234", // E.164, your Twilio-owned number
  // publicBaseUrl is required at connect() time — an HTTPS URL routing to
  // this machine (e.g. an ngrok tunnel). See openTwilioTunnel below.
});

// ── Platform agents (managed voice AI platforms) ──────────────────

// ElevenLabs Conversational AI (hosted — EL runs STT→LLM→TTS).
scenario.elevenLabsAgent({
  agentId: "abc123",
  apiKey: process.env.ELEVENLABS_API_KEY!,
});

// ── Direct model agents (the model IS the agent) ──────────────────

scenario.openAIRealtimeAgent({
  model: "gpt-realtime-mini",
  voice: "alloy",
  instructions: "You are a customer support agent...",
  tools: [
    /* RealtimeToolDef[] — passed straight to the Realtime session */
  ],
});

scenario.geminiLiveAgent({
  model: "gemini-2.5-flash-native-audio-latest",
  voice: "Algieba",
  systemInstruction: "...",
});

// ── Bring your own STT + LLM + TTS ────────────────────────────────

// Composable agent: pick any STT provider + LLM + TTS voice. Runs the
// STT→LLM→TTS pipeline locally (no socket). `stt` is an STTProvider
// instance, `llm` is an AI-SDK LanguageModel, `tts` is "provider/voiceId".
import { openai } from "@ai-sdk/openai";

scenario.composableAgent({
  stt: new voice.OpenAISTTProvider(),
  llm: openai("gpt-4.1-mini"),
  tts: "openai/nova",
});
```

**Class forms** (same adapters, for `extends`/`instanceof`) live under the `voice`
namespace: `voice.PipecatAgentAdapter`, `voice.OpenAIRealtimeAgentAdapter`,
`voice.GeminiLiveAgentAdapter`, `voice.TwilioAgentAdapter`,
`voice.ElevenLabsAgentAdapter`, `voice.ComposableVoiceAgent`, and the
provider-branded preset `voice.ElevenLabsVoiceAgent` (opinionated ElevenLabs
STT + TTS defaults).

**Custom adapter** — subclass `voice.VoiceAgentAdapter`. The executor recognizes
the lifecycle automatically:

```ts
import { voice } from "@langwatch/scenario";

class MyCustomVoiceAgent extends voice.VoiceAgentAdapter {
  readonly capabilities = new voice.AdapterCapabilities({
    streamingTranscripts: false,
    nativeVad: false,
    dtmf: false,
    interruption: false,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });

  async connect() {
    /* open your transport */
  }
  async disconnect() {
    /* close it */
  }
  async sendAudio(chunk: voice.AudioChunk) {
    /* send chunk.data on the wire */
  }
  async receiveAudio(timeout?: number): Promise<voice.AudioChunk> {
    /* read one response chunk; return new voice.AudioChunk({ data }) */
    throw new Error("not implemented");
  }
  // call() is inherited (defaultVoiceCall): it sends the last user audio,
  // receives the agent's response, and returns an audio ModelMessage. The
  // base implementation raises PendingTransportError until connect() runs.
  // Override only for special cases.
}
```

> **Why per-platform adapters, not `voiceAgent({ transport })`?** In practice the
> transport *is* the agent. `pipecatAgent` means "test my Pipecat agent";
> `twilioAgent` means "test via a phone call." Each carries platform-specific,
> type-checked params that wouldn't fit a generic factory or a URL string.

> **Not yet in the TS build.** `LiveKitAgentAdapter`, `VapiAgentAdapter`,
> `WebRTCAgentAdapter`, and `WebSocketAgentAdapter` exist in the **Python** SDK but
> are **not yet ported to TypeScript** — they are not exported from
> `@langwatch/scenario` today. The one transport that *is* present-but-pending in TS
> is **WebRTC mode on Pipecat**: `scenario.pipecatAgent({ transport: "webrtc" })`
> constructs fine but raises `voice.PendingTransportError` at `connect()` until the
> SmallWebRTC transport lands. For a custom WebSocket protocol today, subclass
> `voice.VoiceAgentAdapter` (above).

---

## 2. Voice-enabled user simulator

`userSimulatorAgent` gains a `voice` option. When set, it generates text via the
LLM, then synthesizes audio via TTS.

```ts
import { userSimulatorAgent, voice } from "@langwatch/scenario";

// Text-only (unchanged):
userSimulatorAgent({ model: "openai/gpt-4.1-mini" });

// Voice-enabled:
userSimulatorAgent({
  model: "openai/gpt-4.1-mini",
  voice: "openai/nova", // "provider/voice_name"
});

// With persona, effects, and a per-turn interruption probability:
userSimulatorAgent({
  model: "openai/gpt-4.1-mini",
  voice: "elevenlabs/rachel",
  persona: "Frustrated customer who speaks quickly and tends to interrupt",
  audioEffects: [
    voice.effects.backgroundNoise("cafe", 0.2),
    voice.effects.phoneQuality(),
  ],
  interruptProbability: 0.3, // 30% chance of interrupting each agent turn
});
```

TTS routing follows the litellm pattern, `"provider/voice_name"`:

| String | Provider | Voice |
|--------|----------|-------|
| `"openai/nova"` | OpenAI TTS | nova |
| `"openai/alloy"` | OpenAI TTS | alloy |
| `"elevenlabs/rachel"` | ElevenLabs | rachel |
| `"elevenlabs/raj_indian_english"` | ElevenLabs | accented voice |

Internally: `LLM generates text → TTS synthesizes audio → effects applied → audio
message returned`. The TTS cache is keyed on `(sha256(text), voice)` only — effects
apply **after** the cache read, so the same line is synthesized once and reused.

**Per-step voice / effects overrides** — applied to one turn only, then the
simulator's defaults resume:

```ts
scenario.user("I'm really upset about this!", { voiceStyle: "angry" });
scenario.user("Hello?", { audioEffects: [voice.effects.lowVolume(0.3)] });
```

---

## 3. Voice-enabled judge

The judge adapts automatically when the conversation contains audio — no config
change for the common case.

```ts
import { judgeAgent } from "@langwatch/scenario";

judgeAgent({
  criteria: [
    "Agent handles the interruption gracefully",
    "Agent response latency is acceptable",
    "Agent maintains a professional tone throughout",
  ],
});
```

When audio is present, the judge's input is enriched with:

1. **Transcripts** — automatic STT of every audio message (always included). STT
   runs upstream (a pre-pass before the judge builds its transcript); the judge
   simply receives text. There is no "judge requests a transcript" tool.
2. **Audio** — raw audio passed to multimodal judge models that support it (GPT-4o,
   Gemini).
3. **Timeline** — a structured event log (speaking starts/stops, interrupts, tool
   calls, latencies).
4. **OTel traces** — tool calls and pipeline stages, when LangWatch/OTel is
   configured.

Explicit overrides (advanced):

```ts
judgeAgent({
  criteria: ["..."],
  model: "openai/gpt-4o", // multimodal model that can hear audio
  includeAudio: true, // default: auto-detect from model capability
  includeTimeline: true, // default: true for voice
  includeTraces: true, // default: true when configured
});
```

Auto-detection is the right default: if the conversation has audio AND the judge
model supports audio, pass it; otherwise auto-transcribe and pass text. Set
`includeAudio: false` to force text-only evaluation (e.g. for cost).

---

## 4. Script steps

The script DSL gains voice-specific steps that compose with the existing ones. They
live on the `scenario` object alongside `user`/`agent`/`judge`.

### `scenario.agent({ wait: false })` — non-blocking agent turn

The foundational primitive for interruption testing: triggers the agent's response
but continues the script immediately.

```ts
script: [
  scenario.user("Cancel my flight from New York to LA"),
  scenario.agent({ wait: false }), // agent starts responding, script continues
  scenario.sleep(2), // let the agent talk for 2 seconds
  scenario.user("Wait, I meant Chicago, not LA"), // interrupts!
  scenario.agent(), // wait for the agent's response to the correction
  scenario.judge(),
];
```

> **One `agent` step, two call forms.** `scenario.agent` is the single agent step
> for text and voice (PRD §9, §6.2). Called with content — `agent()`,
> `agent("text")`, `agent(message)` — it behaves exactly as before and **awaits**
> the turn. Called with an options object — `agent({ wait: false })` — it fires the
> turn **without awaiting**, so the next steps run while the agent keeps speaking.
> The forms are distinguished structurally (a message has a `role`; the options
> object does not), so neither is mistaken for the other. `scenario.voiceAgent({
> wait, content })` remains exported as a thin **alias** of the same step for code
> that prefers a voice-named symbol — both resolve to identical behavior.

### `scenario.sleep(seconds)` — timed pause

```ts
scenario.sleep(2); // pause 2 seconds (agent may be speaking during this)
scenario.sleep(0.5);
```

Does NOT transmit audio — it is purely a pause in the script timeline. Useful for
timing interruptions, simulating think-time, and the "long hold" UX.

### `scenario.silence(duration)` — explicit silence

Unlike `sleep` (which just pauses), `silence` actively sends silent PCM16 audio to
the transport — testing an agent whose caller connects but says nothing. Falls back
to a pause when no voice adapter is configured.

```ts
script: [
  scenario.silence(5), // 5 seconds of silence after connecting
  scenario.agent(), // what does the agent say? It should prompt.
  scenario.judge({ criteria: ["Agent prompts the user after silence"] }),
];
```

### `scenario.dtmf(tones)` — DTMF tone injection

For IVR / phone-tree agents. Raises `voice.UnsupportedCapabilityError` unless the
active adapter advertises `capabilities.dtmf` (telephony adapters only):

```ts
script: [
  scenario.agent(), // "Press 1 for billing, 2 for support"
  scenario.dtmf("1"),
  scenario.agent(), // "You've reached billing. How can I help?"
  scenario.user("I have a question about my last invoice"),
  scenario.agent(),
  scenario.judge(),
];
```

### `scenario.audio(pathOrBytes)` — inject pre-recorded audio

Sends a specific audio file (or raw bytes) as user input, bypassing the simulator
and TTS. Accepts a filesystem path string or `Uint8Array`; WAV/MP3/OGG/FLAC are
auto-converted to PCM16 @ 24 kHz mono via the system `ffmpeg` (must be on PATH).
URL-like strings are rejected so ffmpeg never makes outbound requests.

```ts
script: [
  scenario.audio("fixtures/angry_customer_rant.wav"),
  scenario.agent(),
  scenario.audio(rawBytes), // Uint8Array
  scenario.agent(),
  scenario.judge({ criteria: ["Agent asks for clarification when audio is unclear"] }),
];
```

### `scenario.interrupt(options)` — declarative interruption

Sugar over `agent({ wait: false }) + wait + user`. Three trigger modes:

```ts
// TIME-based — let the agent speak ~2s, then interrupt (PRD `interrupt(after=2.0)`):
scenario.interrupt({ after: 2, content: "Wait, that's wrong!" });

// WORD-count-gated — needs streaming transcripts:
scenario.interrupt({ content: "No no no, that's not what I meant", afterWords: 5 });

// First-chunk — bounded wait for the agent to *start*, then interrupt:
scenario.interrupt({ content: "Hold on—" });
```

`content` routing: a plain string → user text (TTS); a string ending `.wav`/`.mp3`/
`.ogg`/`.flac` → audio file; a `Uint8Array` → raw audio bytes. If the adapter lacks
streaming transcripts, `afterWords` raises a clear `voice.UnsupportedCapabilityError`
naming the missing capability and suggesting `interrupt({ content })` instead.

### Interruptions in `proceed()` — fuzz testing

Use the voice form of `proceed` (object arg) to inject random interruptions:

```ts
import { voice } from "@langwatch/scenario";

scenario.voiceProceed({
  turns: 5,
  interruptions: new voice.InterruptionConfig({
    probability: 0.3, // 30% chance per agent turn (default 0.3)
    delayRange: [0.5, 3.0], // random delay before interrupting (default [0.5, 3.0])
    strategy: "contextual", // LLM-generated phrase from running context
    // or: strategy: "random_phrase" → draw from voice.CANNED_PHRASES
  }),
});
```

> The text `scenario.proceed(turns, onTurn?, onStep?)` takes positional args and has
> no `interruptions` knob. The voice variant is exported as `scenario.voiceProceed`
> (object arg); it sits alongside the text steps on the `scenario` object. (The
> non-blocking agent form is just `scenario.agent({ wait: false })` — the same
> `agent` step, no separate export needed.)

> Three levels, from explicit to automatic: **primitive**
> (`agent({ wait: false }) + sleep + user`), **sugar** (`interrupt({...})`),
> **automated** (`voiceProceed({ interruptions })`). Simple tests stay simple;
> complex tests keep full control.

---

## 5. Audio effects

Effects post-process the user simulator's audio to simulate real-world conditions.
They live under the `voice.effects` namespace. Each effect is an `EffectFn` —
`(audio: Uint8Array) => Uint8Array` (PCM16 @ 24 kHz mono in and out) — so they
compose trivially.

```ts
import { userSimulatorAgent, voice } from "@langwatch/scenario";

// Global effects on the simulator:
userSimulatorAgent({
  voice: "openai/nova",
  audioEffects: [
    voice.effects.backgroundNoise("cafe", 0.3), // (preset|wavPath, volume=0.3)
    voice.effects.phoneQuality(), // bandpass + μ-law character
    voice.effects.packetLoss(0.05), // 5% packet loss
  ],
});

// Per-step:
scenario.user("Hello?", { audioEffects: [voice.effects.lowVolume(0.2)] });
```

Built-in effects (camelCase TS names; each returns an `EffectFn`):

| TS name | Args | Effect |
|---|---|---|
| `backgroundNoise` | `(presetOrPath, volume=0.3)` | overlay ambient noise (`"cafe"`, `"street"`, `"office"`, `"airport"`, or a `.wav` path) |
| `phoneQuality` | `()` | phone-line bandpass + μ-law character |
| `lowQuality` | `(...)` | downsample / degrade |
| `packetLoss` | `(probability)` | drop random audio chunks |
| `static` | `(intensity=0.05)` | white-noise static |
| `echo` | `(...)` | delayed-signal echo |
| `speakingFast` | `(factor=1.3)` | time-stretch faster |
| `speakingSlow` | `(factor=0.7)` | time-stretch slower |
| `lowVolume` | `(factor=0.5)` | scale amplitude down |
| `highVolume` | `(factor=1.5)` | scale amplitude up (clips at int16) |
| `robotic` | `(...)` | vocoder-style robotic voice |
| `breakingUp` | `(...)` | intermittent-connection dropout |
| `multipleVoices` | `(backgroundAudio?)` | mix with babble speech sample |
| `custom` | `(fn, opts?)` | your own `(bytes) => bytes` |

For **accents**, pick a TTS voice with the accent rather than post-processing —
there is no `accent` effect by design:

```ts
userSimulatorAgent({ voice: "elevenlabs/raj_indian_english" });
```

Custom effect — the escape hatch. `custom` takes a single `(bytes) => bytes`
function (it validates the callable returns a `Uint8Array`):

```ts
voice.effects.custom((bytes: Uint8Array) => myDsp(bytes));
```

---

## 6. Results & output

`ScenarioResult` gains voice-specific data; all existing fields are unchanged.

```ts
const result = await scenario.run({ /* ... */ });

// ── Existing (unchanged) ──────────────────────────────────────────
result.success; // boolean
result.metCriteria; // string[] — criteria that passed
result.unmetCriteria; // string[] — criteria that failed
result.reasoning; // string | undefined
result.messages; // ModelMessage[] — now includes audio data
result.totalTime; // seconds (optional)
result.agentTime; // seconds (optional)

// ── New voice fields (present on voice runs) ──────────────────────
result.audio; // VoiceRecording | undefined
result.timeline; // VoiceEvent[] | undefined
result.latency; // LatencyMetrics | undefined
```

**`VoiceRecording`** (`result.audio`):

```ts
result.audio?.segments; // AudioSegment[]
//   .speaker     → "user" | "agent"
//   .startTime   → 0.0 (seconds)
//   .endTime     → 2.3
//   .audio       → Uint8Array (PCM16 LE, mono, 24kHz)
//   .transcript  → "I need help with my bill"  (optional)

result.audio?.duration; // total seconds (max segment endTime)
result.audio?.timeline; // the same VoiceEvent[] as result.timeline
```

> The runtime that *persists* a recording is `voice.VoiceRecordingRuntime` (its
> `save(...)` / `saveSegments(...)` methods write `full.wav` + per-segment WAVs +
> `manifest.json` via the system ffmpeg — the same on-disk shape committed under
> [`javascript/recordings/`](../../javascript/recordings/README.md)). The
> `VoiceRecording` on `result.audio` is the data contract those methods consume.

**`VoiceEvent[]`** (`result.timeline`):

```ts
result.timeline;
// [
//   { time: 0.0, type: "user_start_speaking" },
//   { time: 2.3, type: "user_stop_speaking" },
//   { time: 2.5, type: "agent_start_speaking", latency: 0.2 },
//   { time: 3.0, type: "tool_call", name: "get_billing", args: { ... } },
//   { time: 3.5, type: "tool_result", name: "get_billing", result: { ... } },
//   { time: 5.1, type: "user_interrupt", metadata: { native: true } },
//   { time: 5.2, type: "agent_stop_speaking" },
//   ...
// ]
```

**`LatencyMetrics`** (`result.latency`):

```ts
result.latency?.avgResponseTime; // mean user-stop → agent-start
result.latency?.p50ResponseTime;
result.latency?.p95ResponseTime;
result.latency?.timeToFirstByte; // first agent audio byte
result.latency?.interruptResponseTime; // how fast the agent stops after an interrupt
result.latency?.measurements; // number[] — individual measurements
```

**Live observability hooks** — stream events/audio as the run executes (pass on
`run()`):

```ts
await scenario.run({
  // ...
  onAudioChunk: (chunk) => myPlayer.feed(chunk),
  onVoiceEvent: (event) => myLogger.log(event),
});
```

---

## 7. Per-run provider config (ADR-002)

STT/TTS providers are configured **per run**, not globally — there is no
`scenario.configure({ stt })`. Pass `voice` to `run()`:

```ts
import { voice } from "@langwatch/scenario";

const result = await scenario.run({
  // ...
  voice: {
    stt: new voice.ElevenLabsSTTProvider({ apiKey: process.env.ELEVENLABS_API_KEY }),
    tts: { voice: "openai/nova" },
    // judge knobs also resolvable here:
    includeAudio: true,
    includeTimeline: true,
    includeTraces: true,
  },
});
```

`voice.stt` accepts either a concrete `STTProvider` instance (bring-your-own) or a
descriptor `{ model: "openai/gpt-4o-transcribe" }` resolved through the provider
router. When unset, the default OpenAI provider (`gpt-4o-transcribe`) is constructed
per-run. Because config is per-run, concurrent `scenario.run()` calls with different
providers stay isolated — they never clobber each other (the reason the old global
was removed; see `docs/adr/002-voice-provider-state.md`).

`scenario.configure({ ... })` remains for **global execution** settings only — e.g.
`scenario.configure({ audioPlayback: true })` to play conversation audio live (the
flag is stored on the config; live-device playback is a deferred consumer).

---

## 8. Worked examples (mirroring the PRD §6)

### 8.1 Basic voice conversation

```ts
import scenario, { userSimulatorAgent, judgeAgent } from "@langwatch/scenario";

const result = await scenario.run({
  name: "basic greeting",
  description: "Agent greets the caller and offers help",
  agents: [
    scenario.pipecatAgent({ url: "ws://localhost:8765/ws" }),
    userSimulatorAgent({ voice: "openai/nova" }),
    judgeAgent({
      criteria: ["Agent greets the caller warmly", "Agent asks how it can help"],
    }),
  ],
  script: [
    scenario.agent(), // agent speaks first (greeting)
    scenario.user("Hi, I need some help"),
    scenario.agent(),
    scenario.judge(),
  ],
});

expect(result.success).toBe(true);
```

### 8.2 Interruption handling

```ts
const result = await scenario.run({
  name: "interruption recovery",
  description: "User interrupts to correct a misunderstanding; agent should adapt",
  agents: [
    scenario.pipecatAgent({ url: "ws://localhost:8765/ws" }),
    userSimulatorAgent({ voice: "openai/nova" }),
    judgeAgent({
      criteria: [
        "Agent stops speaking when interrupted",
        "Agent addresses the correction without repeating wrong info",
        "Agent does not express frustration at being interrupted",
      ],
    }),
  ],
  script: [
    scenario.user("I need to change my flight from New York to Los Angeles"),
    scenario.agent({ wait: false }), // agent starts responding (non-blocking)
    scenario.sleep(2), // let it talk for 2 seconds
    scenario.user("Wait sorry, I meant Chicago, not LA"), // interrupt!
    scenario.agent(), // agent responds to the correction
    scenario.judge(),
  ],
});

expect(result.success).toBe(true);
expect(result.latency?.interruptResponseTime).toBeLessThan(1.0); // stops within 1s
```

### 8.3 Angry customer with background noise

```ts
import { voice } from "@langwatch/scenario";

const result = await scenario.run({
  name: "angry customer in noisy cafe",
  description: "Angry customer calling from a loud cafe about a double charge",
  agents: [
    scenario.pipecatAgent({ url: "ws://localhost:8765/ws" }),
    userSimulatorAgent({
      voice: "elevenlabs/rachel",
      persona: "Very angry customer, raised voice, impatient",
      audioEffects: [
        voice.effects.backgroundNoise("cafe", 0.4),
        voice.effects.phoneQuality(),
      ],
    }),
    judgeAgent({
      criteria: [
        "Agent remains calm and empathetic despite the angry tone",
        "Agent acknowledges frustration before problem-solving",
        "Agent clearly communicates despite the noisy background",
        "Agent offers a concrete resolution",
      ],
    }),
  ],
  script: [
    scenario.user("Yeah I got charged TWICE for my subscription, this is ridiculous!"),
    scenario.agent(),
    scenario.user(), // LLM generates the angry follow-up
    scenario.agent(),
    scenario.judge(),
  ],
});

expect(result.success).toBe(true);
```

### 8.4 DTMF phone-tree navigation

```ts
const result = await scenario.run({
  name: "IVR phone tree",
  description: "Navigate the phone menu to reach billing",
  agents: [
    scenario.twilioAgent({
      accountSid: process.env.TWILIO_ACCOUNT_SID!,
      authToken: process.env.TWILIO_AUTH_TOKEN!,
      phoneNumber: "+14155551234",
    }),
    userSimulatorAgent({ voice: "openai/alloy" }),
    judgeAgent({
      criteria: [
        "Agent presents menu options clearly",
        "Agent routes to billing after pressing 1",
      ],
    }),
  ],
  script: [
    scenario.agent(), // IVR greeting + menu
    scenario.dtmf("1"), // press 1 for billing
    scenario.agent(),
    scenario.user("I have a question about my last invoice"),
    scenario.agent(),
    scenario.judge(),
  ],
});

expect(result.success).toBe(true);
```

### 8.5 Tool-call verification with a plain step function

A plain function is a valid script step — it receives the `ScenarioExecutionState`
at its position. Use `state.hasToolCall(name)` to assert a tool fired (the
step-level state exposes `messages`, `lastAgentMessage()`, `hasToolCall(name)`,
`currentTurn`, etc. — the full voice `timeline` lives on the final `result`, not on
the per-step state):

```ts
function assertToolCalled(state) {
  expect(state.hasToolCall("get_customer_info")).toBe(true);
}

const result = await scenario.run({
  name: "tool usage over voice",
  agents: [
    scenario.pipecatAgent({ url: "ws://localhost:8765/ws" }),
    userSimulatorAgent({ voice: "openai/nova" }),
    judgeAgent({ criteria: ["Agent looks up the customer's account information"] }),
  ],
  script: [
    scenario.user("Can you look up my account? My ID is C-12345."),
    scenario.agent(),
    assertToolCalled, // plain step — runs at this position
    scenario.user(),
    scenario.agent(),
    scenario.judge(),
  ],
});
```

### 8.6 Silence handling

```ts
const result = await scenario.run({
  name: "silence timeout",
  description: "Agent should prompt the user after extended silence",
  agents: [
    scenario.pipecatAgent({ url: "ws://localhost:8765/ws" }),
    userSimulatorAgent({ voice: "openai/nova" }),
    judgeAgent({
      criteria: [
        "Agent prompts the user after silence",
        "Agent does not hang up prematurely",
      ],
    }),
  ],
  script: [
    scenario.user("Hold on, let me find my account number..."),
    scenario.silence(10), // 10 seconds of silence
    scenario.agent(), // "Are you still there?"
    scenario.user("Sorry, yes, my account is A-5678"),
    scenario.agent(),
    scenario.judge(),
  ],
});

expect(result.success).toBe(true);
```

### 8.7 Random interruptions with `voiceProceed`

```ts
import { voice } from "@langwatch/scenario";

const result = await scenario.run({
  name: "interruption resilience",
  description: "Multi-turn conversation where the user randomly interrupts",
  agents: [
    scenario.pipecatAgent({ url: "ws://localhost:8765/ws" }),
    userSimulatorAgent({
      voice: "openai/nova",
      persona: "Impatient customer who sometimes interrupts",
    }),
    judgeAgent({
      criteria: [
        "Agent recovers gracefully from every interruption",
        "Agent never loses context of the conversation",
        "Agent completes the customer's request despite interruptions",
      ],
    }),
  ],
  script: [
    scenario.user("I need to update my shipping address"),
    scenario.voiceProceed({
      turns: 5,
      interruptions: new voice.InterruptionConfig({ probability: 0.4 }),
    }),
    scenario.judge(),
  ],
});

expect(result.success).toBe(true);
```

### 8.8 OpenAI Realtime as the user simulator (advanced)

For a truly natural, prosodically-rich voice (hesitations, fillers, intonation),
use a realtime model in the USER role instead of TTS:

```ts
import { AgentRole } from "@langwatch/scenario";

scenario.openAIRealtimeAgent({
  role: AgentRole.USER,
  model: "gpt-realtime-mini",
  voice: "nova",
  instructions: "You are simulating a confused elderly customer...",
});
```

This is an advanced case; the default TTS-based simulator covers the vast majority
of testing (it's controllable, ~10× cheaper, and deterministic with caching).

> **Note.** When the OpenAI Realtime user simulator is paired with a *different*
> agent adapter (e.g. Pipecat), there is no cross-adapter audio bridge yet — that
> pairing is skip-guarded rather than crashing. See the capability matrix.

---

## What voice testing is for

Use voice to catch what text can't: interruption handling, latency/responsiveness,
emotional-tone response, audio-quality robustness, DTMF navigation, silence
handling, turn-taking/barge-in, and the full STT→LLM→TTS pipeline. Keep RAG quality,
knowledge accuracy, basic conversation flow, and prompt iteration on **text** tests —
they're faster, cheaper, and deterministic. Voice catches the ~20% of bugs that
cause ~80% of voice-agent user complaints.

---

## Capabilities & deferred transports

- Every adapter exposes a `capabilities` object
  (`voice.AdapterCapabilities`): `streamingTranscripts`, `nativeVad`, `dtmf`,
  `interruption`, `inputFormats`, `outputFormats`. `dtmf("1")` on a non-telephony
  adapter (or `interrupt({ afterWords })` without streaming transcripts) raises
  `voice.UnsupportedCapabilityError`. See
  [`javascript/docs/voice/capability-matrix.md`](../../javascript/docs/voice/capability-matrix.md)
  for the per-adapter render.
- Check capabilities programmatically before adding capability-gated steps:

  ```ts
  const adapter = scenario.pipecatAgent({ url: "ws://localhost:8765/ws" });
  if (adapter.capabilities.dtmf) script.push(scenario.dtmf("1#"));
  if (adapter.capabilities.streamingTranscripts) {
    script.push(scenario.interrupt({ afterWords: 3, content: "Wait" }));
  } else {
    script.push(scenario.interrupt({ content: "Wait" })); // first-chunk barge-in
  }
  ```

- `voice.AudioChunk` is the framework-internal canonical format — PCM16, 24 kHz,
  mono. Each adapter converts to/from its transport-native format (e.g. μ-law/8 kHz
  for Twilio) at the send/receive boundary.
- **Shipped TS adapters:** Pipecat (WebSocket), Twilio, OpenAI Realtime, Gemini
  Live, ElevenLabs (hosted ConvAI + the `ElevenLabsVoiceAgent` composable preset),
  and the generic `ComposableVoiceAgent`. **Not yet ported to TS** (Python-only):
  LiveKit, Vapi, generic WebRTC, generic WebSocket.
- **Pending transport (TS):** WebRTC mode on Pipecat
  (`pipecatAgent({ transport: "webrtc" })`) raises `voice.PendingTransportError` at
  `connect()` until the SmallWebRTC transport lands. Twilio real-phone demos require
  a tunnel (`voice.openTwilioTunnel`) + a second number and are gated manual.

---

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
