# Voice Adapter Capability Matrix

Every `VoiceAgentAdapter` publishes an `AdapterCapabilities` instance as its
class-level `capabilities` attribute. Capability-gated script steps — such as
`interrupt(after_words=N)` (needs streaming transcripts) or `dtmf()` (needs
telephony) — check this record and raise `UnsupportedCapabilityError` when the
underlying adapter cannot implement the requested behavior.

This page is the authoritative render of what each shipped adapter advertises.
When `UnsupportedCapabilityError` or `PendingTransportError` point users here,
this is the page they land on.

## Matrix

| Adapter | Streaming transcripts | Native VAD | DTMF | Input formats | Output formats | Real transport? |
|---|---|---|---|---|---|---|
| `PipecatAgentAdapter` | ✅ | ✅ | ❌ | pcm16/24000, mulaw/8000, opus | pcm16/24000, mulaw/8000, opus | ✅ WebSocket only (WebRTC deferred) |
| `LiveKitAgentAdapter` | ✅ | ✅ | ❌ | pcm16/48000 | pcm16/48000 | ❌ raises `PendingTransportError` |
| `TwilioAgentAdapter` | ❌ | ❌ | ✅ | mulaw/8000 | mulaw/8000 | ✅ bidirectional Media Streams |
| `ElevenLabsAgentAdapter` | ✅ | ✅ | ❌ | pcm16/24000 | pcm16/24000 | ❌ raises `PendingTransportError` |
| `VapiAgentAdapter` | ✅ | ✅ | ❌ | pcm16/16000 | pcm16/16000 | ❌ raises `PendingTransportError` |
| `OpenAIRealtimeAgentAdapter` | ✅ | ✅ | ❌ | pcm16/24000 | pcm16/24000 | ❌ raises `PendingTransportError` (text routing works) |
| `GeminiLiveAgentAdapter` | ✅ | ✅ | ❌ | pcm16/16000 | pcm16/24000 | ❌ raises `PendingTransportError` |
| `WebSocketAgentAdapter` | ❌ | ❌ | ❌ | pcm16/24000 | pcm16/24000 | ⚠️ user-supplied `WebSocketProtocol` |
| `WebRTCAgentAdapter` | ❌ | ❌ | ❌ | pcm16/24000 | pcm16/24000 | ❌ raises `PendingTransportError` |

Internal audio format is always PCM16 @ 24kHz mono (`AudioChunk`); each adapter
converts at its send/recv boundary.

## Capability semantics

- **Streaming transcripts** — the adapter emits incremental transcript tokens
  as the agent speaks. Required for `scenario.interrupt(after_words=N)`.
  Without it, that step raises `UnsupportedCapabilityError` and points here.
- **Native VAD** — the adapter emits `user_start_speaking` /
  `user_stop_speaking` events from its own voice-activity-detection pipeline.
  When `False`, the SDK falls back to `webrtcvad-wheels` on the incoming audio
  stream and emits a one-shot `UserWarning` ("Adapter X has no native VAD —
  using SDK-side webrtcvad, accuracy may differ").
- **DTMF** — the adapter can transmit DTMF tones over a telephony transport.
  Required for `scenario.dtmf("1234#")`. Without it, that step raises
  `UnsupportedCapabilityError`.
- **Input formats** — wire formats the adapter can accept from the SDK for
  outgoing user audio. The SDK converts `AudioChunk` PCM16/24000 to one of
  these at the adapter boundary.
- **Output formats** — wire formats the adapter emits for incoming agent
  audio. The SDK converts these back to internal PCM16/24000 mono before
  exposing them as `AudioChunk`s.

## Errors that reference this page

- `scenario.voice.capabilities.UnsupportedCapabilityError` — raised when a
  script step requests a capability the adapter does not advertise (e.g.,
  `dtmf()` on a non-telephony adapter, `interrupt(after_words=N)` on an
  adapter without streaming transcripts).
- `scenario.voice.adapters.PendingTransportError` — raised by adapter stubs
  whose `send_audio` / `recv_audio` implementations have not landed yet.
  Points users here so they can pick an adapter with a real transport
  (today: Twilio or Pipecat/WebSocket) or subclass and implement their own.

## Checking capabilities programmatically

```python
adapter = scenario.PipecatAgentAdapter(url="ws://localhost:8765/ws")

if adapter.capabilities.dtmf:
    script.append(scenario.dtmf("1#"))

if adapter.capabilities.streaming_transcripts:
    script.append(scenario.interrupt(after_words=3, content="Wait"))
else:
    # Fall back to time-based interruption — works on every adapter.
    script.append(scenario.interrupt(after=2.0, content="Wait"))
```

## Authoring a custom adapter

When subclassing `VoiceAgentAdapter`, re-declare `capabilities` with accurate
flags. Inheriting a parent's `AdapterCapabilities` ClassVar and not re-auditing
it will silently break capability-gated script steps. For instance, claiming
`streaming_transcripts=True` when your transport only delivers completed
transcripts will cause `interrupt(after_words=N)` to hang indefinitely because
no partial-transcript events ever arrive.

```python
class MyCustomAdapter(scenario.VoiceAgentAdapter):
    capabilities = scenario.voice.AdapterCapabilities(
        streaming_transcripts=False,
        native_vad=False,
        dtmf=False,
        input_formats=["pcm16/24000"],
        output_formats=["pcm16/24000"],
    )
```

## Deferred / follow-up items

- Transport implementations for LiveKit, ElevenLabs, Vapi, OpenAI Realtime
  (audio I/O; text routing works), Gemini Live, and generic WebRTC are
  deferred to a follow-up issue. Their `capabilities` declarations above
  describe what they *will* support — today they raise
  `PendingTransportError` at `send_audio` / `recv_audio`.
- The generic `WebSocketAgentAdapter` is a pluggable harness: users supply a
  `WebSocketProtocol` that handles framing for their specific service.
