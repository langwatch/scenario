# Voice Adapter Capability Matrix

Every `VoiceAgentAdapter` publishes an `AdapterCapabilities` instance as its
class-level `capabilities` attribute. Capability-gated script steps — such as
`interrupt(after_words=N)` (needs streaming transcripts), `dtmf()` (needs
telephony), or `interrupt(content)` over a native cancel signal (needs
`interruption=True`) — check this record and either route correctly or raise
`UnsupportedCapabilityError` when the underlying adapter cannot implement the
requested behavior.

This page is the authoritative render of what each shipped adapter advertises.
When `UnsupportedCapabilityError` or `PendingTransportError` point users here,
this is the page they land on.

## Provider × capability matrix

Internal audio format is always PCM16 @ 24 kHz mono (`AudioChunk`); each
adapter converts at its send/recv boundary.

| Adapter | Streaming transcripts | Native VAD | DTMF | Interruption (native cancel) | Wire transport | Real I/O? |
|---|---|---|---|---|---|---|
| `PipecatAgentAdapter` | ✅ | ✅ | ❌ | ✅ Twilio Media Streams `clear` | WebSocket | ✅ |
| `TwilioAgentAdapter` | ❌ | ❌ | ✅ | ✅ Twilio Media Streams `clear` | WebSocket (Media Streams) | ✅ |
| `OpenAIRealtimeAgentAdapter` | ✅ | ✅ | ❌ | ✅ `response.cancel` | WebSocket | ✅ |
| `ElevenLabsAgentAdapter` | ✅ | ✅ | ❌ | ❌ — server-side VAD barge-in only | WebSocket | ✅ |
| `GeminiLiveAgentAdapter` | ✅ | ✅ | ❌ | ✅ Activity marker cancel | WebSocket | ✅ |
| `LiveKitAgentAdapter` | ✅ | ✅ | ❌ | ❌ | WebRTC (planned) | ❌ stub raises `PendingTransportError` |
| `VapiAgentAdapter` | ✅ | ✅ | ❌ | ❌ | WebSocket (planned) | ❌ stub raises `PendingTransportError` |
| `WebRTCAgentAdapter` | ❌ | ❌ | ❌ | ❌ | WebRTC | ❌ stub raises `PendingTransportError` |
| `WebSocketAgentAdapter` | ❌ | ❌ | ❌ | ❌ | user-supplied `WebSocketProtocol` | ⚠️ depends on user code |

**Wire formats** (PCM16 mono at the listed sample rate):

| Adapter | Input | Output |
|---|---|---|
| `PipecatAgentAdapter` | pcm16/24000, mulaw/8000, opus | pcm16/24000, mulaw/8000, opus |
| `TwilioAgentAdapter` | mulaw/8000 | mulaw/8000 |
| `OpenAIRealtimeAgentAdapter` | pcm16/24000 | pcm16/24000 |
| `ElevenLabsAgentAdapter` | pcm16/24000 | pcm16/24000 |
| `GeminiLiveAgentAdapter` | pcm16/16000 | pcm16/24000 |
| `LiveKitAgentAdapter` | pcm16/48000 | pcm16/48000 |
| `VapiAgentAdapter` | pcm16/16000 | pcm16/16000 |
| `WebRTCAgentAdapter` | pcm16/24000 | pcm16/24000 |
| `WebSocketAgentAdapter` | pcm16/24000 | pcm16/24000 |

## Use case × provider — demos

The `examples/voice/` directory has one demo per use case. Each picks a
provider that supports the capability the demo proves; the cell shows where
the same use case could also work with substitution.

Legend:
- ✅ shipped — running demo lives at `examples/voice/<file>.py` for the listed
  provider, or via simple adapter substitution.
- 🟡 supported, no demo — the capability works on the listed adapter but no
  demo file exists yet. Track in follow-up issues.
- ❌ unsupported — the adapter's transport or capability flags do not allow
  this use case. Don't try.
- ⏸ skipped — possible in principle but cost-prohibitive (real phone call,
  paid voice, etc.); covered manually rather than in CI.

| Use case | Demo | Pipecat WS | Twilio | OpenAI Realtime | ElevenLabs | Gemini Live |
|---|---|---|---|---|---|---|
| Basic greeting | `basic_greeting.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Interruption recovery | `interruption_recovery.py` | ✅ | 🟡 | 🟡 | ❌ until SDK wires interrupt | ❌ until SDK wires interrupt |
| Random interruptions | `random_interruptions.py` | ✅ | 🟡 | 🟡 | ❌ | ❌ |
| DTMF IVR navigation | `dtmf_ivr.py` | ❌ no DTMF | ✅ | ❌ no DTMF | ❌ no DTMF | ❌ no DTMF |
| Pre-recorded audio | `prerecorded_audio.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Tool call verification | `tool_verification.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Silence handling | `silence_handling.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Long hold (15s wait) | `long_hold.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Multi-intent in one turn | `multi_intent.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Background handoff (effects) | `background_handoff.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Accent-misunderstanding loop | `accent_loop.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Angry customer + cafe noise | `angry_customer.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Emotional escalation | `emotional_escalation.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Twilio inbound call | `twilio_inbound.py` | ❌ | ⏸ real phone | ❌ | ❌ | ❌ |
| Twilio outbound call | `twilio_outbound.py` | ❌ | ⏸ real phone | ❌ | ❌ | ❌ |
| ElevenLabs branded composable | `elevenlabs_branded.py` | ❌ | ❌ | ❌ | ✅ | ❌ |
| ElevenLabs hosted ConvAI | `elevenlabs_hosted.py` | ❌ | ❌ | ❌ | ✅ | ❌ |
| Gemini Live native audio | `gemini_live.py` | ❌ | ❌ | ❌ | ❌ | ✅ |
| OpenAI Realtime as agent | `openai_realtime_agent.py` | ❌ | ❌ | ✅ | ❌ | ❌ |
| OpenAI Realtime as user sim | `openai_realtime_user.py` | n/a | n/a | currently skip-guarded — no cross-adapter audio bridge yet | n/a | n/a |
| Pipecat WebSocket happy path | `pipecat_ws.py` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Pipecat scenario harness | `pipecat_scenario.py` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Recording + playback | `recording_playback.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| STT provider swap | `stt_swap.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Voice/text entrypoint parity | `voice_text_parity.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Observability hooks + latency | `observability.py` | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |

🟡 cells convert to ✅ by swapping the adapter in the demo's `agents=[...]`
list. They're 🟡 not because the use case fails — it generally works — but
because a verified, recorded, rendered demo doesn't yet exist for that
combination. File issues for the gaps you care about.

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
- **Interruption (native cancel)** — the adapter can send a transport-level
  cancel signal that stops the agent under test mid-utterance (Twilio
  Media Streams `clear`, OpenAI Realtime `response.cancel`, etc.). Required
  for first-class barge-in. Without it, `scenario.interrupt(content)` falls
  back to overlapping user audio with the agent's TTS and relying on the
  AUT's own VAD-based barge-in (less deterministic).

  Interrupts are inherently a **duplex-channel** capability: the SDK has to
  send a control frame while the agent is still streaming. HTTP/REST
  transports cannot support this. WebSocket and WebRTC adapters can.

  Two flavours exist in the wild:

  1. **Client-initiated cancel** — the SDK sends a control frame
     (`response.cancel` for OpenAI Realtime, `clear` for Twilio Media
     Streams / Pipecat-over-Twilio). Deterministic and explicit. The
     adapter publishes `interruption=True` and implements
     `async def interrupt()`.
  2. **Server-side VAD barge-in** — the provider's own VAD listens to
     incoming user audio and cancels its current response when speech is
     detected (ElevenLabs ConvAI, Gemini Live). The client only needs to
     keep streaming user audio; there is no separate cancel frame and no
     `interrupt()` method. The adapter advertises `interruption=False`
     because we cannot send a cancel signal — the only knob is "send the
     next user chunk." Barge-in still works, but its timing is the
     server's call, not ours.
- **Input formats / Output formats** — wire formats the adapter accepts /
  emits. The SDK converts internally.

## Errors that reference this page

- `scenario.voice.capabilities.UnsupportedCapabilityError` — raised when a
  script step requests a capability the adapter does not advertise (e.g.,
  `dtmf()` on a non-telephony adapter, `interrupt(after_words=N)` on an
  adapter without streaming transcripts).
- `scenario.voice.adapters.PendingTransportError` — raised by adapter stubs
  whose `send_audio` / `recv_audio` implementations have not landed yet.
  Points users here so they can pick an adapter with a real transport
  (today: Pipecat WS, Twilio, OpenAI Realtime, ElevenLabs, Gemini Live) or
  subclass and implement their own.

## Checking capabilities programmatically

```python
adapter = scenario.PipecatAgentAdapter(url="ws://localhost:8765/ws")

if adapter.capabilities.dtmf:
    script.append(scenario.dtmf("1#"))

if adapter.capabilities.streaming_transcripts:
    script.append(scenario.interrupt(after_words=3, content="Wait"))
else:
    # Event-driven barge-in works on every adapter; native cancel fires
    # iff capabilities.interruption=True.
    script.append(scenario.interrupt(content="Wait"))
```

## Authoring a custom adapter

When subclassing `VoiceAgentAdapter`, re-declare `capabilities` with accurate
flags. Inheriting a parent's `AdapterCapabilities` ClassVar and not re-auditing
it will silently break capability-gated script steps. For instance, claiming
`streaming_transcripts=True` when your transport only delivers completed
transcripts will cause `interrupt(after_words=N)` to hang indefinitely because
no partial-transcript events ever arrive. Claiming `interruption=True` without
implementing `async def interrupt()` will make the executor call a method that
doesn't exist.

```python
class MyCustomAdapter(scenario.VoiceAgentAdapter):
    capabilities = scenario.voice.AdapterCapabilities(
        streaming_transcripts=False,
        native_vad=False,
        dtmf=False,
        interruption=False,
        input_formats=["pcm16/24000"],
        output_formats=["pcm16/24000"],
    )
```

## Deferred / follow-up items

- **Native interrupt for ElevenLabs**. Investigated; the provider runs
  server-side VAD and has no client-initiated cancel frame in its public
  protocol. Setting `interruption=True` would be incorrect — `interrupt()`
  would have nothing to send. Barge-in works the moment the executor's
  next user audio chunk hits the wire; no SDK change required. EL emits a
  server→client `interruption` event when its VAD fires; surfacing that
  into the voice timeline is a separate enhancement. (Gemini Live also
  runs server-side VAD but additionally exposes Activity markers — the
  Gemini Live adapter uses those for explicit cancel, so it does publish
  `interruption=True`.)
- **Transport implementations for LiveKit, Vapi, WebRTC**. Stubs raise
  `PendingTransportError` at `send_audio` / `recv_audio`. The capability
  declarations describe what they *will* support.
- **`OpenAIRealtimeAgentAdapter(role=USER)` cross-adapter audio bridging**.
  When the OpenAI Realtime user simulator is paired with a different agent
  adapter (e.g. Pipecat), there's no bridge piping the user-side audio into
  the agent-side input. Demo `openai_realtime_user.py` skip-guards rather
  than crashing.
- **Use-case demos for non-default providers** (the 🟡 cells above). File
  issues per (use case × provider) you want covered.
