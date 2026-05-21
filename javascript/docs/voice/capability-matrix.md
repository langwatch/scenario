# Voice Adapter Capability Matrix — TypeScript SDK

> **Status: placeholder.** PR1 of the TS voice parity slice (issue #372)
> ships the type contract surface only — no concrete adapters land yet.
> The rows below mirror the Python source-of-truth at
> `docs/voice/capability-matrix.md`; cells marked `pending` will become
> ✅ / ❌ as their PRs land. This doc exists in PR1 so error messages
> (`UnsupportedCapabilityError`) and the planned doc-render test have a
> stable path to point at.

Every `VoiceAgentAdapter` will publish an `AdapterCapabilities` instance as
its `capabilities` field. Capability-gated script steps — such as
`interrupt({ afterWords: N })` (needs streaming transcripts), `dtmf()`
(needs telephony), or `interrupt(content)` over a native cancel signal
(needs `interruption=true`) — check this record and either route correctly
or throw `UnsupportedCapabilityError` when the underlying adapter cannot
implement the requested behavior.

When `UnsupportedCapabilityError` points users here, this is the page they
land on.

## Provider × capability matrix

Internal audio format is always PCM16 @ 24 kHz mono (`AudioChunk`); each
adapter will convert at its send/recv boundary.

| Adapter | Streaming transcripts | Native VAD | DTMF | Interruption (native cancel) | Wire transport | Real I/O? |
|---|---|---|---|---|---|---|
| `PipecatAgentAdapter` | pending | pending | pending | pending | WebSocket | pending |
| `TwilioAgentAdapter` | pending | pending | pending | pending | WebSocket (Media Streams) | pending |
| `OpenAIRealtimeAgentAdapter` | pending | pending | pending | pending | WebSocket | pending |
| `ElevenLabsAgentAdapter` | pending | pending | pending | pending | WebSocket | pending |
| `GeminiLiveAgentAdapter` | pending | pending | pending | pending | WebSocket | pending |
| `LiveKitAgentAdapter` | pending | pending | pending | pending | WebRTC (planned) | pending |
| `VapiAgentAdapter` | pending | pending | pending | pending | WebSocket (planned) | pending |
| `WebRTCAgentAdapter` | pending | pending | pending | pending | WebRTC | pending |
| `WebSocketAgentAdapter` | pending | pending | pending | pending | user-supplied `WebSocketProtocol` | pending |

**Wire formats** (PCM16 mono at the listed sample rate) will be filled in
per adapter as the transports land.

## Capability semantics

- **Streaming transcripts** — the adapter emits incremental transcript
  tokens as the agent speaks. Required for
  `scenario.interrupt({ afterWords: N })`. Without it, that step raises
  `UnsupportedCapabilityError` and points here.
- **Native VAD** — the adapter emits `user_start_speaking` /
  `user_stop_speaking` events from its own voice-activity-detection
  pipeline. When `false`, the SDK will fall back to a WASM build of
  webrtcvad on the incoming audio stream and emit a one-shot warning per
  adapter ("Adapter X has no native VAD — using SDK-side webrtcvad,
  accuracy may differ").
- **DTMF** — the adapter can transmit DTMF tones over a telephony
  transport. Required for `scenario.dtmf("1234#")`. Without it, that step
  raises `UnsupportedCapabilityError`.
- **Interruption (native cancel)** — the adapter can send a transport-level
  cancel signal that stops the agent under test mid-utterance (Twilio
  Media Streams `clear`, OpenAI Realtime `response.cancel`, etc.). Required
  for first-class barge-in. Without it, `scenario.interrupt(content)` will
  fall back to overlapping user audio with the agent's TTS and relying on
  the AUT's own VAD-based barge-in (less deterministic).

  Interrupts are inherently a **duplex-channel** capability: the SDK has to
  send a control frame while the agent is still streaming. HTTP/REST
  transports cannot support this. WebSocket and WebRTC adapters can.

- **Input formats / Output formats** — wire formats the adapter accepts /
  emits. The SDK converts internally.

## Errors that reference this page

- `voice.UnsupportedCapabilityError` — raised when a script step requests
  a capability the adapter does not advertise (e.g. `dtmf()` on a
  non-telephony adapter, `interrupt({ afterWords: N })` on an adapter
  without streaming transcripts).
- `voice.PendingTransportError` (PR2+) — will be raised by adapter stubs
  whose `sendAudio` / `receiveAudio` implementations have not landed yet.

## Authoring a custom adapter

When subclassing `VoiceAgentAdapter`, declare `capabilities` with accurate
flags. Inheriting a parent's `AdapterCapabilities` and not re-auditing it
will silently break capability-gated script steps.

```ts
import { voice } from "@langwatch/scenario";

class MyCustomAdapter extends voice.VoiceAgentAdapter {
  readonly capabilities = new voice.AdapterCapabilities({
    streamingTranscripts: false,
    nativeVad: false,
    dtmf: false,
    interruption: false,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });

  async connect() { /* ... */ }
  async disconnect() { /* ... */ }
  async sendAudio(_chunk: voice.AudioChunk) { /* ... */ }
  async receiveAudio(_timeout: number): Promise<voice.AudioChunk> {
    throw new Error("not implemented");
  }
  async call(_input: any): Promise<any> { /* PR2+ */ }
}
```

## Deferred / follow-up items

- Concrete adapter classes (PR2+) — Pipecat WS, Twilio, OpenAI Realtime,
  ElevenLabs, Gemini Live.
- VAD fallback (WASM webrtcvad build).
- Effects module + bundled CC0 noise samples.
- Voice-aware `UserSimulatorAgent` and `JudgeAgent`.
- Pluggable STT interface (`scenario.configure({ stt })`).
