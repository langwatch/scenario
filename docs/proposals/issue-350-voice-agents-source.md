# Claude Opus #1 Proposal

# Scenario Voice Testing — API Design Proposal

## 1. Vision & Philosophy

Voice testing in Scenario should follow the same principle that makes text testing elegant: **you describe a scenario, simulate a conversation, and judge the outcome**. The only thing that changes is the *medium* — audio instead of text.

This means: **no `scenario.voice.run()`**, no separate paradigm. The same `scenario.run()`, the same script DSL, the same judge criteria. You make it a voice test by using voice-capable agents. A developer looking at a voice test should immediately recognize it as a Scenario test.

```python
result = await scenario.run(
    name="billing dispute - angry customer",
    description="Customer calls angry about double charge, agent should de-escalate",
    agents=[
        scenario.PipecatAgent(url="ws://localhost:8765/ws"),
        scenario.UserSimulatorAgent(voice="openai/nova"),
        scenario.JudgeAgent(criteria=[
            "Agent remains calm and professional despite angry tone",
            "Agent acknowledges the customer's frustration before problem-solving",
            "Agent offers a concrete resolution (refund, credit, or escalation)",
        ]),
    ],
    script=[
        scenario.user("Yeah hi, I just got charged TWICE for my subscription, what the hell?"),
        scenario.agent(),
        scenario.user(),
        scenario.agent(),
        scenario.judge(),
    ],
)
assert result.success
```

**This is a voice test.** The only difference from a text test is `PipecatAgent(url=...)` instead of `MyAgent()`, and `voice="openai/nova"` on the user simulator. Everything else is identical.

---

## 2. What Voice Testing Is Actually For

Before designing the API, we need to be honest about what voice testing uniquely validates versus what's better tested via text.

### Test via voice (things text can't catch)

| Category | Example | Why voice-only |
| --- | --- | --- |
| **Interruption handling** | User cuts agent off mid-sentence | Text is strictly turn-based; interruptions only exist in audio |
| **Latency/responsiveness** | Time from user silence to agent speech | Measured in milliseconds of audio, not API call time |
| **Emotional tone response** | Agent stays calm when user is angry | Tone exists only in audio; transcript loses emotional context |
| **Audio quality robustness** | Agent with background noise, bad mic | Noise/quality degrades audio, text is unaffected |
| **DTMF navigation** | Phone tree: "Press 1 for billing" | Only exists in telephony |
| **Silence handling** | User goes quiet for 10 seconds | Voice agents must decide when to prompt; text agents don't have this problem |
| **Tool call reliability under voice** | Agent calls function after voice input | Voice→STT→LLM→tool is a different failure mode than text→LLM→tool |
| **Hold/wait experience** | What happens during long tool calls | Hold music, "please wait" — voice-specific UX |
| **Turn-taking/barge-in** | Agent speaks too early, overlapping user | Only exists in realtime audio |
| **End-to-end pipeline** | Full STT→LLM→TTS round trip | Integration test of the whole voice stack |

### Don't test via voice (use text instead)

| Category | Why text is better |
| --- | --- |
| RAG retrieval quality | The retrieval is the same regardless of input modality |
| Knowledge accuracy | Same LLM, same knowledge, text is cheaper and faster |
| Provider STT accuracy | You're testing ElevenLabs/Deepgram, not your agent |
| Basic conversation flow | Text tests are 10x faster and deterministic |
| Prompt engineering | Iterate with text, validate final version with voice |

**The value proposition**: Voice testing catches the failures that only happen when real audio enters the pipeline — the 20% of bugs that cause 80% of user complaints.

---

## 3. Architecture

### How voice fits into existing Scenario

```
                     ┌─────────────────────────────┐
                     │       scenario.run()         │
                     │    (same as text testing)     │
                     └──────────┬──────────────────┘
                                │
                     ┌──────────▼──────────────────┐
                     │     ScenarioExecutor         │
                     │  (turn loop, script steps)   │
                     └──────────┬──────────────────┘
                                │
              ┌─────────────────┼──────────────────┐
              │                 │                   │
   ┌──────────▼───────┐ ┌──────▼────────┐ ┌───────▼────────┐
   │  Agent Under Test │ │ User Simulator│ │     Judge      │
   │  (AgentAdapter)   │ │ (AgentAdapter)│ │ (AgentAdapter) │
   └──────────┬───────┘ └──────┬────────┘ └───────┬────────┘
              │                │                   │
         ┌────▼────┐    ┌─────▼─────┐      ┌─────▼──────┐
   TEXT:  │ Your    │    │ LLM text  │      │ LLM reads  │
         │ code    │    │ generation│      │ transcript │
         └─────────┘    └───────────┘      └────────────┘

         ┌────▼────┐    ┌─────▼─────┐      ┌─────▼──────┐
  VOICE: │Transport│    │ LLM text  │      │ LLM reads  │
         │(WS/RTC/ │    │ + TTS     │      │ audio +    │
         │ Phone)  │    │ + Effects │      │ transcript │
         └─────────┘    └───────────┘      │ + timeline │
                                           └────────────┘
```

**What changes:**

- New agent adapter classes for voice platforms (PipecatAgent, TwilioAgent, etc.)
- UserSimulatorAgent gains TTS capability via `voice=` parameter
- JudgeAgent auto-detects audio and includes it in evaluation
- New script steps: `interrupt()`, `dtmf()`, `audio()`, `silence()`
- ScenarioResult gains audio recording, timeline, and latency data

**What stays the same:**

- `scenario.run()` signature
- Script step concept and execution model
- `user()`, `agent()`, `judge()`, `proceed()`, `succeed()`, `fail()`
- AgentAdapter interface
- Criteria-based judgment
- Turn counting and max_turns
- Caching system
- Event system and LangWatch integration

---

## 4. Core API

### 4.1 Voice Agent Adapters

These connect Scenario to the voice agent under test. Each one implements `AgentAdapter` and handles platform-specific connection management.

```python
# ── Framework agents (connect to your running agent) ──────────────

# Pipecat agent via WebSocket (Twilio-style bidirectional stream)
scenario.PipecatAgent(
    url="ws://localhost:8765/ws",
    audio_format="pcm16",       # or "mulaw" for telephony
    sample_rate=24000,           # match your agent's config
)

# Pipecat agent via WebRTC (SmallWebRTC transport)
scenario.PipecatAgent(
    signaling_url="<http://localhost:7860/api/offer>",
    transport="webrtc",
)

# LiveKit agent (join a LiveKit room as a participant)
scenario.LiveKitAgent(
    url="wss://my-app.livekit.cloud",
    api_key="...",
    api_secret="...",
    room="test-room",
)

# ── Phone testing ──────────────────────────────────────────────────

# Call an actual phone number via Twilio
scenario.TwilioAgent(
    phone_number="+14155551234",
    from_number="+14155559876",
    account_sid="...",
    auth_token="...",
)

# ── Platform agents (managed voice AI platforms) ──────────────────

# ElevenLabs Conversational AI
scenario.ElevenLabsAgent(
    agent_id="abc123",
    api_key="...",
)

# Vapi assistant
scenario.VapiAgent(
    assistant_id="...",
    api_key="...",
)

# ── Direct model agents (model IS the agent) ─────────────────────

# OpenAI Realtime API
scenario.OpenAIRealtimeAgent(
    model="gpt-4o-realtime-preview",
    voice="alloy",
    instructions="You are a customer support agent...",
    tools=[...],
)

# Gemini Live
scenario.GeminiLiveAgent(
    model="gemini-2.5-flash-native-audio",
    voice="Algieba",
    system_instruction="...",
)

# ── Generic (bring your own protocol) ─────────────────────────────

# Any WebSocket endpoint (you define the message protocol)
scenario.WebSocketAgent(
    url="wss://my-agent.com/ws",
    protocol=MyCustomProtocol(),  # implements send_audio/recv_audio
)

# Any WebRTC endpoint
scenario.WebRTCAgent(
    signaling_url="<https://my-agent.com/api/offer>",
)
```

**Lifecycle management:** The executor automatically calls `connect()` when a scenario starts and `disconnect()` when it ends. No manual lifecycle management needed.

```python
class VoiceAgentAdapter(AgentAdapter):
    """Base class for all voice agent adapters."""

    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def send_audio(self, audio: bytes, format: str) -> None: ...
    async def recv_audio(self, timeout: float) -> AudioChunk: ...

    # AgentAdapter interface
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        audio = extract_audio(input.new_messages[-1])
        await self.send_audio(audio)
        response = await self.recv_audio(timeout=self.response_timeout)
        return create_audio_message(response.audio, response.transcript)
```

**Design decision — per-platform classes vs unified VoiceAgent(transport=...):**

I considered `scenario.VoiceAgent(transport=PipecatTransport(url="..."))` — separating transport from agent. I rejected this because in practice, the transport IS the agent. There's no meaningful agent logic separate from the transport. The per-platform classes are clearer: `PipecatAgent` means "test my Pipecat agent," `TwilioAgent` means "test via phone call." The classes also have platform-specific parameters that don't make sense on a generic VoiceAgent.

**Alternative considered — litellm-style string routing:**

```python
scenario.VoiceAgent("pipecat/ws://localhost:8765/ws")  # Rejected
```

This is too magical and loses type safety. Platform-specific parameters (room name, API keys, audio format) don't fit in a URL string. Explicit classes are more discoverable and IDE-friendly.

### 4.2 Voice-Enabled User Simulator

The existing `UserSimulatorAgent` gains voice capabilities via the `voice` parameter. When `voice` is set, the simulator generates text via LLM, then converts to audio via TTS.

```python
# Text-only (unchanged):
scenario.UserSimulatorAgent(model="openai/gpt-4.1-mini")

# Voice-enabled:
scenario.UserSimulatorAgent(
    model="openai/gpt-4.1-mini",
    voice="openai/nova",           # "provider/voice_name" format
)

# With persona and effects:
scenario.UserSimulatorAgent(
    model="openai/gpt-4.1-mini",
    voice="elevenlabs/rachel",
    persona="Frustrated customer who speaks quickly and tends to interrupt",
    audio_effects=[
        scenario.effects.background_noise("cafe", volume=0.2),
        scenario.effects.phone_quality(),
    ],
    interrupt_probability=0.3,      # 30% chance of interrupting each agent turn
)
```

**TTS provider routing** follows the litellm pattern — `"provider/voice_name"`:

| String | Provider | Voice |
| --- | --- | --- |
| `"openai/nova"` | OpenAI TTS | nova |
| `"openai/alloy"` | OpenAI TTS | alloy |
| `"elevenlabs/rachel"` | ElevenLabs | rachel |
| `"elevenlabs/raj"` | ElevenLabs | raj (Indian English accent) |
| `"google/en-US-Neural2-F"` | Google Cloud TTS | Neural2 Female |
| `"cartesia/sonic-english"` | Cartesia | sonic-english |

Internally, `UserSimulatorAgent` detects the `voice` parameter and wraps itself with a TTS pipeline:

```
LLM generates text → TTS synthesizes audio → Effects applied → Audio message returned
```

**Per-step voice overrides:**

```python
# Override voice/effects for a specific step:
scenario.user("I'm really upset about this!", voice_style="angry")
scenario.user("Hello?", audio_effects=[scenario.effects.low_volume(0.3)])
```

**Design decision — extend UserSimulatorAgent vs new VoiceUserSimulator class:**

I chose extension because:

1. The text generation logic is identical — only the output format changes
2. `voice=` is a natural parameter that clearly communicates "this is a voice sim"
3. One class to learn, not two
4. Internally, it can subclass/compose as needed (implementation detail)

The alternative (separate class) would mean users need to learn when to use which, and the LLM configuration would be duplicated.

### 4.3 Voice-Enabled Judge

The judge **automatically adapts** when the conversation contains audio. No configuration change needed for the common case.

```python
# Same API as text — auto-detects audio:
scenario.JudgeAgent(criteria=[
    "Agent handles the interruption gracefully",
    "Agent response latency is acceptable",
    "Agent maintains professional tone throughout",
])
```

**What the judge receives:**

When audio is present in the conversation, the judge's `AgentInput` is enriched with:

1. **Transcripts** — automatic STT of all audio messages (always included)
2. **Audio** — raw audio passed to multimodal models that support it (GPT-4o, Gemini)
3. **Timeline** — structured event log:

```
Timeline:
  00:00.0  [user]  starts speaking
  00:02.3  [user]  stops speaking (2.3s utterance)
  00:02.5  [agent] starts speaking (0.2s latency)
  00:05.1  [user]  INTERRUPTS agent
  00:05.2  [agent] stops speaking (0.1s interrupt response time)
  00:05.3  [user]  starts speaking
  00:07.1  [user]  stops speaking
  00:07.8  [agent] starts speaking (0.7s latency)
  00:12.4  [agent] stops speaking

  Tool calls:
    00:03.0  get_billing_info(customer_id="C-123") → {balance: 49.99}

  Latency:
    avg_response: 0.45s | p95_response: 0.70s | interrupt_response: 0.10s
```

1. **OTel traces** — tool calls, pipeline stages (when LangWatch/OTel is configured)

**Explicit audio analysis configuration** (optional, for advanced use):

```python
scenario.JudgeAgent(
    criteria=[...],
    model="openai/gpt-4o",      # Multimodal model that can hear audio
    include_audio=True,          # Pass audio to judge (default: auto-detect model capability)
    include_timeline=True,       # Include structured timeline (default: True for voice)
    include_traces=True,         # Include OTel traces (default: True when configured)
)
```

**Design decision — auto-detect vs explicit configuration:**

Auto-detection is the right default. If the conversation has audio AND the judge model supports audio input (GPT-4o, Gemini), pass it. If the model doesn't support audio (GPT-4.1-mini), auto-transcribe and pass text. The developer only needs to override when they want specific behavior (e.g., force text-only evaluation for cost reasons).

### 4.4 Script Extensions

The core script DSL gains voice-specific steps. These compose naturally with existing steps.

### `scenario.agent(wait=False)` — Non-blocking agent turn

The foundational primitive for interruption testing. Triggers the agent's response but continues the script immediately without waiting for it to complete.

```python
script=[
    scenario.user("Cancel my flight from New York to LA"),
    scenario.agent(wait=False),    # Agent starts responding, script continues
    scenario.sleep(2.0),           # Let agent talk for 2 seconds
    scenario.user("Wait, I meant Chicago, not LA"),  # Interrupts!
    scenario.agent(),              # Wait for agent's response to the interruption
    scenario.judge(),
]
```

**How it works internally:**

1. `agent(wait=False)` sends the user's audio to the transport and returns immediately
2. The transport starts receiving the agent's audio stream
3. `sleep(2.0)` pauses the script for 2 seconds (agent is speaking during this time)
4. `user("Wait...")` generates TTS audio and sends it to the transport
5. The transport sends audio while the agent is still speaking — this IS the interruption
6. The voice agent detects user speech (via VAD), stops its own output, and processes the new input
7. `agent()` (with default `wait=True`) waits for the agent's response to the interruption

### `scenario.sleep(seconds)` — Timed pause

```python
scenario.sleep(2.0)   # Pause for 2 seconds
scenario.sleep(0.5)   # Half-second pause
```

Useful for:

- Timing interruptions
- Simulating user think time
- Testing silence handling ("user goes quiet for 10 seconds")

### `scenario.silence(duration)` — Explicit silence

Unlike `sleep()` (which just pauses the script), `silence()` actively sends silent audio to the transport. This tests how the agent handles a user who connects but says nothing.

```python
script=[
    scenario.silence(5.0),   # 5 seconds of silence after connecting
    scenario.agent(),        # What does the agent say? Should prompt the user.
    scenario.judge(criteria=["Agent prompts the user after silence"]),
]
```

### `scenario.dtmf(tones)` — DTMF tone injection

For testing IVR/phone tree agents:

```python
script=[
    scenario.agent(),        # Agent: "Press 1 for billing, 2 for support"
    scenario.dtmf("1"),      # Press 1
    scenario.agent(),        # Agent: "You've reached billing. How can I help?"
    scenario.user("I have a question about my last invoice"),
    scenario.agent(),
    scenario.judge(),
]
```

### `scenario.audio(path_or_bytes)` — Inject pre-recorded audio

Send a specific audio file as user input. Bypasses the user simulator and TTS entirely.

```python
script=[
    scenario.audio("fixtures/angry_customer_rant.wav"),
    scenario.agent(),
    scenario.audio("fixtures/mumbly_question.mp3"),
    scenario.agent(),
    scenario.judge(criteria=["Agent asks for clarification when audio is unclear"]),
]
```

Accepts file paths (str/Path) or raw bytes. Supports WAV, MP3, OGG, FLAC — auto-converted to the transport's required format.

### `scenario.interrupt()` — Syntactic sugar for interruptions

Combines `agent(wait=False)` + `sleep()` into a declarative step:

```python
# These are equivalent:

# Explicit (low-level):
scenario.agent(wait=False),
scenario.sleep(2.0),
scenario.user("Wait, that's wrong!"),

# Declarative (sugar):
scenario.interrupt(
    after=2.0,                           # Seconds after agent starts speaking
    content="Wait, that's wrong!",       # Text (auto-TTS) or audio path
)
```

`interrupt()` can also use word count instead of time:

```python
scenario.interrupt(
    after_words=5,     # Interrupt after agent speaks ~5 words (uses streaming transcript)
    content="No no no, that's not what I meant",
)
```

### Interruptions in `proceed()`

For non-deterministic testing with random interruptions:

```python
scenario.proceed(
    turns=5,
    interruptions=scenario.InterruptionConfig(
        probability=0.3,           # 30% chance per agent turn
        delay_range=(0.5, 3.0),    # Random delay before interrupting
        strategy="contextual",     # LLM generates contextual interruption text
        # OR
        strategy="random_phrase",  # Pick from common interrupt phrases
    ),
)
```

### 4.5 Audio Effects & Simulation

Effects are applied to user simulator audio as post-processing. They simulate real-world conditions that voice agents must handle.

```python
from scenario import effects

# Global effects on user simulator:
scenario.UserSimulatorAgent(
    voice="openai/nova",
    audio_effects=[
        effects.background_noise("cafe", volume=0.3),
        effects.phone_quality(),                  # 8kHz, μ-law compression
        effects.packet_loss(probability=0.05),    # 5% packet loss
    ],
)

# Per-step effects:
scenario.user("Hello?", audio_effects=[effects.low_volume(0.2)])
scenario.user("I said CANCEL!", audio_effects=[effects.high_volume(1.5), effects.speaking_fast(1.3)])
```

**Built-in effects:**

| Effect | What it does | Implementation |
| --- | --- | --- |
| `background_noise(preset, volume)` | Overlays ambient noise | Mix with bundled noise samples (cafe, street, office, airport) or custom WAV |
| `phone_quality()` | Simulates phone line | Bandpass filter (300Hz-3.4kHz) + μ-law compression |
| `low_quality(bitrate)` | Degrades audio quality | Downsample + lossy compression |
| `packet_loss(probability)` | Drops random audio chunks | Zero out random segments |
| `static(intensity)` | Adds static/crackle | Overlay white noise bursts |
| `echo(delay_ms)` | Adds echo | Delayed signal overlay |
| `speaking_fast(factor)` | Speed up speech | Time-stretch without pitch change |
| `speaking_slow(factor)` | Slow down speech | Time-stretch without pitch change |
| `low_volume(factor)` | Reduce volume | Amplitude scaling |
| `high_volume(factor)` | Increase volume | Amplitude scaling |
| `robotic()` | Makes voice sound robotic | Vocoder effect |
| `breaking_up()` | Simulates intermittent connection | Random dropout + compression artifacts |
| `multiple_voices(background_audio)` | Background conversation | Mix with speech babble sample |
| `custom(fn)` | Custom effect | User-provided `fn(audio_bytes) -> audio_bytes` |

**For accents:** Use a TTS voice with the desired accent rather than post-processing:

```python
# Indian English accent via ElevenLabs accented voice:
scenario.UserSimulatorAgent(voice="elevenlabs/raj_indian_english")

# British accent:
scenario.UserSimulatorAgent(voice="elevenlabs/dorothy_british")
```

**Implementation:** Effects use ffmpeg (via subprocess) or numpy for audio manipulation. The framework bundles a small set of noise samples (~5 WAVs, <1MB total). Custom noise files can be provided by path.

**Effects that vary during the conversation:**

```python
scenario.proceed(
    turns=3,
    on_turn=lambda state: state.set_effects(
        [effects.background_noise("cafe", volume=0.1 * state.current_turn)]
        # Noise increases each turn
    ),
)
```

### 4.6 Results & Output

`ScenarioResult` is extended with voice-specific data. All existing fields remain unchanged.

```python
result = await scenario.run(...)

# ── Existing fields (unchanged) ──────────────────────────────────
result.success            # bool
result.passed_criteria    # List[str]
result.failed_criteria    # List[str]
result.reasoning          # str
result.messages           # List[message]  — now includes audio data
result.total_time         # float (seconds)
result.agent_time         # float (seconds)

# ── New voice fields ─────────────────────────────────────────────
result.audio              # VoiceRecording — full conversation audio
result.timeline           # List[VoiceEvent] — timestamped events
result.latency            # LatencyMetrics — response time stats
```

**VoiceRecording:**

```python
result.audio.save("conversation.wav")              # Save full recording
result.audio.save("conversation.mp3", format="mp3")

result.audio.segments      # List[AudioSegment]
# AudioSegment:
#   .speaker     → "user" | "agent"
#   .start_time  → 0.0 (seconds)
#   .end_time    → 2.3
#   .audio       → bytes (WAV)
#   .transcript  → "I need help with my bill"

result.audio.duration      # Total duration in seconds
result.audio.full_wav      # bytes — full conversation as WAV
```

**VoiceEvent timeline:**

```python
result.timeline
# [
#   VoiceEvent(time=0.0,  type="user_start_speaking"),
#   VoiceEvent(time=2.3,  type="user_stop_speaking"),
#   VoiceEvent(time=2.5,  type="agent_start_speaking", latency=0.2),
#   VoiceEvent(time=3.0,  type="tool_call", name="get_billing", args={...}),
#   VoiceEvent(time=3.5,  type="tool_result", name="get_billing", result={...}),
#   VoiceEvent(time=5.1,  type="user_interrupt"),
#   VoiceEvent(time=5.2,  type="agent_stop_speaking"),
#   VoiceEvent(time=5.3,  type="user_start_speaking"),
#   ...
# ]
```

**LatencyMetrics:**

```python
result.latency.avg_response_time       # Average time from user stop → agent start
result.latency.p50_response_time
result.latency.p95_response_time
result.latency.time_to_first_byte      # Time to first audio byte from agent
result.latency.interrupt_response_time # How fast agent stops after interrupt
result.latency.measurements            # List of individual measurements
```

### 4.7 Real-time Monitoring

During test execution, voice audio can be streamed for live listening.

```python
# Global config:
scenario.configure(
    audio_playback=True,      # Play conversation through speakers in real-time
)

# Per-test:
result = await scenario.run(
    ...,
    audio_playback=True,
    verbose=2,                # Level 2 shows real-time transcripts in console
)
```

**Event hooks for custom monitoring:**

```python
result = await scenario.run(
    ...,
    on_audio_chunk=lambda chunk: my_player.feed(chunk),
    on_voice_event=lambda event: my_logger.log(event),
)
```

---

## 5. Integration Guide by Platform

### 5.1 Pipecat Agents

Pipecat agents expose either a WebSocket endpoint (for Twilio integration) or a WebRTC endpoint (SmallWebRTC). Scenario connects as a client.

**WebSocket (Twilio-style):**

```python
# Your pipecat agent runs with: python bot.py -t twilio --host 0.0.0.0 --port 8765
# It exposes POST / (TwiML) and WebSocket /ws

result = await scenario.run(
    agents=[
        scenario.PipecatAgent(
            url="ws://localhost:8765/ws",
            audio_format="mulaw",    # Twilio uses μ-law
            sample_rate=8000,        # Twilio uses 8kHz
        ),
        scenario.UserSimulatorAgent(voice="openai/nova"),
        scenario.JudgeAgent(criteria=[...]),
    ],
    script=[...],
)
```

**WebRTC (SmallWebRTC):**

```python
# Your pipecat agent runs with: python bot.py -t webrtc --host 0.0.0.0 --port 7860
# It exposes POST /api/offer for WebRTC signaling

result = await scenario.run(
    agents=[
        scenario.PipecatAgent(
            signaling_url="<http://localhost:7860/api/offer>",
            transport="webrtc",
        ),
        ...
    ],
    script=[...],
)
```

**White-box (in-process):** If you want to run the pipecat bot in the same process as the test (no network), you can create a custom adapter that drives the pipeline directly:

```python
class MyPipecatAgent(scenario.AgentAdapter):
    async def call(self, input):
        # Drive your pipecat pipeline directly
        audio = extract_audio(input)
        response = await self.pipeline.process(audio)
        return create_audio_message(response)
```

### 5.2 LiveKit Agents

```python
result = await scenario.run(
    agents=[
        scenario.LiveKitAgent(
            url="wss://my-app.livekit.cloud",
            api_key=os.environ["LIVEKIT_API_KEY"],
            api_secret=os.environ["LIVEKIT_API_SECRET"],
            room="test-room-123",
        ),
        scenario.UserSimulatorAgent(voice="openai/alloy"),
        scenario.JudgeAgent(criteria=[...]),
    ],
    script=[...],
)
```

Scenario joins the LiveKit room as a participant, publishes audio (user simulator), and subscribes to the agent's audio track.

### 5.3 Twilio (Phone Call)

```python
result = await scenario.run(
    agents=[
        scenario.TwilioAgent(
            phone_number="+14155551234",     # Number to call
            from_number="+14155559876",      # Your Twilio number
            account_sid=os.environ["TWILIO_ACCOUNT_SID"],
            auth_token=os.environ["TWILIO_AUTH_TOKEN"],
        ),
        scenario.UserSimulatorAgent(voice="openai/nova"),
        scenario.JudgeAgent(criteria=[...]),
    ],
    script=[
        scenario.agent(),                    # Wait for agent greeting
        scenario.user("I need billing help"),
        scenario.agent(),
        scenario.dtmf("1"),                  # Press 1
        scenario.agent(),
        scenario.judge(),
    ],
)
```

**How it works:** Scenario creates an outbound Twilio call to the target number, establishes a Media Stream (bidirectional WebSocket), and sends/receives audio over that stream.

### 5.4 ElevenLabs Conversational AI

```python
result = await scenario.run(
    agents=[
        scenario.ElevenLabsAgent(
            agent_id="abc123",
            api_key=os.environ["ELEVENLABS_API_KEY"],
        ),
        scenario.UserSimulatorAgent(voice="openai/nova"),
        scenario.JudgeAgent(criteria=[...]),
    ],
    script=[...],
)
```

Connects via `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...`, sends PCM16 audio chunks, receives agent responses.

### 5.5 Vapi

```python
result = await scenario.run(
    agents=[
        scenario.VapiAgent(
            assistant_id="...",
            api_key=os.environ["VAPI_API_KEY"],
        ),
        ...
    ],
    script=[...],
)
```

Uses Vapi's WebSocket transport: creates a call via REST API, connects via the returned `websocketCallUrl`, streams bidirectional audio.

### 5.6 OpenAI Realtime / Gemini Live

For direct model testing (the model IS the agent):

```python
# OpenAI Realtime:
result = await scenario.run(
    agents=[
        scenario.OpenAIRealtimeAgent(
            model="gpt-4o-realtime-preview",
            voice="alloy",
            instructions="You are a customer support agent...",
            tools=[get_billing_info, cancel_subscription],
        ),
        scenario.UserSimulatorAgent(voice="elevenlabs/rachel"),
        scenario.JudgeAgent(criteria=[...]),
    ],
    script=[...],
)

# Gemini Live:
result = await scenario.run(
    agents=[
        scenario.GeminiLiveAgent(
            model="gemini-2.5-flash-native-audio",
            voice="Algieba",
            system_instruction="...",
        ),
        ...
    ],
    script=[...],
)
```

### 5.7 Custom HTTP/WebSocket

For agents with custom protocols, implement the `VoiceAgentAdapter` interface:

```python
class MyCustomVoiceAgent(scenario.VoiceAgentAdapter):
    async def connect(self):
        self.ws = await websockets.connect("wss://my-agent.com/ws")

    async def send_audio(self, audio: bytes, format: str) -> None:
        await self.ws.send(json.dumps({
            "type": "audio",
            "data": base64.b64encode(audio).decode(),
        }))

    async def recv_response(self, timeout: float) -> VoiceResponse:
        msg = await asyncio.wait_for(self.ws.recv(), timeout)
        data = json.loads(msg)
        return VoiceResponse(
            audio=base64.b64decode(data["audio"]),
            transcript=data.get("transcript"),
        )

    async def disconnect(self):
        await self.ws.close()
```

Or use the generic `WebSocketAgent` with a protocol adapter:

```python
class MyProtocol(scenario.WebSocketProtocol):
    def encode_audio(self, audio: bytes) -> str | bytes:
        return json.dumps({"type": "audio", "data": base64.b64encode(audio).decode()})

    def decode_response(self, message: str | bytes) -> VoiceResponse:
        data = json.loads(message)
        return VoiceResponse(audio=base64.b64decode(data["audio"]))

scenario.WebSocketAgent(url="wss://my-agent.com/ws", protocol=MyProtocol())
```

---

## 6. Full Example Tests

### 6.1 Basic voice conversation

```python
@pytest.mark.asyncio
async def test_greeting_flow():
    result = await scenario.run(
        name="basic greeting",
        description="Agent greets the caller and offers help",
        agents=[
            scenario.PipecatAgent(url="ws://localhost:8765/ws"),
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(criteria=[
                "Agent greets the caller warmly",
                "Agent asks how it can help",
            ]),
        ],
        script=[
            scenario.agent(),                    # Agent speaks first (greeting)
            scenario.user("Hi, I need some help"),
            scenario.agent(),
            scenario.judge(),
        ],
    )
    assert result.success
    result.audio.save("test_output/greeting.wav")
```

### 6.2 Interruption handling

```python
@pytest.mark.asyncio
async def test_interruption_handling():
    result = await scenario.run(
        name="interruption recovery",
        description="User interrupts to correct a misunderstanding, agent should adapt",
        agents=[
            scenario.PipecatAgent(url="ws://localhost:8765/ws"),
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(criteria=[
                "Agent stops speaking when interrupted",
                "Agent addresses the correction without repeating wrong info",
                "Agent does not express frustration at being interrupted",
            ]),
        ],
        script=[
            scenario.user("I need to change my flight from New York to Los Angeles"),
            scenario.agent(wait=False),          # Agent starts responding
            scenario.sleep(2.0),                 # Let it talk for 2 seconds
            scenario.user("Wait sorry, I meant Chicago, not LA"),  # Interrupt!
            scenario.agent(),                    # Agent responds to correction
            scenario.judge(),
        ],
    )
    assert result.success
    assert result.latency.interrupt_response_time < 1.0  # Should stop within 1s
```

### 6.3 Angry customer with background noise

```python
@pytest.mark.asyncio
async def test_angry_customer_noisy_environment():
    result = await scenario.run(
        name="angry customer in noisy cafe",
        description="Angry customer calling from a loud cafe about a double charge",
        agents=[
            scenario.PipecatAgent(url="ws://localhost:8765/ws"),
            scenario.UserSimulatorAgent(
                voice="elevenlabs/rachel",
                persona="Very angry customer, raised voice, impatient",
                audio_effects=[
                    scenario.effects.background_noise("cafe", volume=0.4),
                    scenario.effects.phone_quality(),
                ],
            ),
            scenario.JudgeAgent(criteria=[
                "Agent remains calm and empathetic despite angry tone",
                "Agent acknowledges frustration before problem-solving",
                "Agent clearly communicates despite noisy background",
                "Agent offers a concrete resolution",
            ]),
        ],
        script=[
            scenario.user("Yeah I got charged TWICE for my subscription, this is ridiculous!"),
            scenario.agent(),
            scenario.user(),        # LLM generates angry follow-up
            scenario.agent(),
            scenario.user(),        # LLM continues the angry persona
            scenario.agent(),
            scenario.judge(),
        ],
    )
    assert result.success
```

### 6.4 DTMF phone tree navigation

```python
@pytest.mark.asyncio
async def test_ivr_navigation():
    result = await scenario.run(
        name="IVR phone tree",
        description="Navigate phone menu to reach billing department",
        agents=[
            scenario.TwilioAgent(phone_number="+14155551234"),
            scenario.UserSimulatorAgent(voice="openai/alloy"),
            scenario.JudgeAgent(criteria=[
                "Agent presents menu options clearly",
                "Agent routes to billing after pressing 1",
                "Agent confirms which department the caller reached",
            ]),
        ],
        script=[
            scenario.agent(),              # IVR greeting + menu
            scenario.dtmf("1"),            # Press 1 for billing
            scenario.agent(),              # Billing dept greeting
            scenario.user("I have a question about my last invoice"),
            scenario.agent(),
            scenario.judge(),
        ],
    )
    assert result.success
```

### 6.5 Tool call verification

```python
@pytest.mark.asyncio
async def test_tool_calls_in_voice():
    def assert_tool_called(state):
        tool_events = [e for e in state.timeline if e.type == "tool_call" and e.name == "get_customer_info"]
        assert len(tool_events) > 0, "Expected tool call to get_customer_info"

    result = await scenario.run(
        name="tool usage over voice",
        description="Agent should look up customer info when asked about account",
        agents=[
            scenario.PipecatAgent(url="ws://localhost:8765/ws"),
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(criteria=[
                "Agent looks up the customer's account information",
                "Agent communicates the account details clearly",
            ]),
        ],
        script=[
            scenario.user("Can you look up my account? My ID is C-12345."),
            scenario.agent(),
            assert_tool_called,              # Verify tool was called
            scenario.user(),
            scenario.agent(),
            scenario.judge(),
        ],
    )
    assert result.success
```

### 6.6 Pre-recorded audio injection

```python
@pytest.mark.asyncio
async def test_mumbly_audio_handling():
    result = await scenario.run(
        name="unclear audio handling",
        description="Agent should ask for clarification when audio is unclear",
        agents=[
            scenario.PipecatAgent(url="ws://localhost:8765/ws"),
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(criteria=[
                "Agent asks for clarification instead of guessing",
                "Agent does not assume or hallucinate what was said",
            ]),
        ],
        script=[
            scenario.audio("fixtures/mumbly_inaudible_question.wav"),
            scenario.agent(),                    # Should ask "could you repeat that?"
            scenario.user("Sorry, I said I want to cancel my subscription"),
            scenario.agent(),
            scenario.judge(),
        ],
    )
    assert result.success
```

### 6.7 Random interruptions with proceed()

```python
@pytest.mark.asyncio
async def test_handles_random_interruptions():
    result = await scenario.run(
        name="interruption resilience",
        description="Multi-turn conversation where user randomly interrupts",
        agents=[
            scenario.PipecatAgent(url="ws://localhost:8765/ws"),
            scenario.UserSimulatorAgent(
                voice="openai/nova",
                persona="Impatient customer who sometimes interrupts",
                interrupt_probability=0.4,
            ),
            scenario.JudgeAgent(criteria=[
                "Agent recovers gracefully from every interruption",
                "Agent never loses context of the conversation",
                "Agent completes the customer's request despite interruptions",
            ]),
        ],
        script=[
            scenario.user("I need to update my shipping address"),
            scenario.proceed(turns=5),
            scenario.judge(),
        ],
    )
    assert result.success
```

### 6.8 Silence handling

```python
@pytest.mark.asyncio
async def test_silence_handling():
    result = await scenario.run(
        name="silence timeout",
        description="Agent should prompt user after extended silence",
        agents=[
            scenario.PipecatAgent(url="ws://localhost:8765/ws"),
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(criteria=[
                "Agent prompts the user after silence",
                "Agent does not hang up prematurely",
                "Agent asks if the user is still there",
            ]),
        ],
        script=[
            scenario.user("Hold on, let me find my account number..."),
            scenario.silence(10.0),              # 10 seconds of silence
            scenario.agent(),                    # Agent should say "Are you still there?"
            scenario.user("Sorry, yes, my account is A-5678"),
            scenario.agent(),
            scenario.judge(),
        ],
    )
    assert result.success
```

---

## 7. Design Decisions & Alternatives

### 7.1 Turn-based vs. streaming conversation model

**Chosen: Turn-based (extended with async primitives)**

The existing Scenario model is turn-based: user → agent → judge → repeat. Voice conversations in reality are NOT turn-based — both parties can speak simultaneously. However:

- **Most voice agent testing IS turn-based.** You want to verify: "when user says X, agent responds Y." The turn model maps directly to this.
- **Interruptions are the exception, not the rule.** They're handled with `wait=False` + `sleep()` — composable primitives that don't require a new paradigm.
- **Turn-based tests are reproducible.** Streaming tests have timing-dependent behavior that makes CI flaky.
- **Turn-based tests are readable.** The script reads like a conversation script, which is what it is.

**Alternative rejected: Full streaming model**

```python
# Rejected:
async with scenario.voice_stream(agent) as stream:
    await stream.send("Hello")
    async for event in stream.events():
        if event.type == "agent_speaking" and event.elapsed > 2.0:
            await stream.interrupt("Wait!")
```

This is more powerful but:

- Every test becomes imperative code, losing declarative clarity
- Timing-dependent, making tests flaky
- Doesn't compose with existing `proceed()`, `judge()`, etc.
- Much harder to visualize in the Simulations Visualizer

### 7.2 TTS-based user simulator vs. realtime voice model

**Chosen: TTS-based as default**

The user simulator uses LLM (text generation) + TTS (speech synthesis) rather than a realtime voice model (like OpenAI Realtime).

- **Controllable:** You know exactly what words are being said (the transcript is the TTS input, not an ASR approximation)
- **Cheaper:** TTS is ~10x cheaper than realtime voice models
- **Composable:** Text effects (persona, style) and audio effects (noise, quality) are separate concerns
- **Deterministic with caching:** Same text + same voice = same audio

**When to use realtime voice models instead:**

For testing how your agent handles a truly natural, prosodically-rich voice conversation (with natural hesitations, fillers, intonation), you can use:

```python
scenario.OpenAIRealtimeAgent(
    role=AgentRole.USER,
    model="gpt-4o-realtime-preview",
    voice="nova",
    instructions="You are simulating a confused elderly customer...",
)
```

This is an advanced use case. The default TTS-based simulator covers 95% of testing needs.

### 7.3 Per-platform agent classes vs. unified VoiceAgent(transport=...)

**Chosen: Per-platform classes**

`scenario.PipecatAgent(url=...)` instead of `scenario.VoiceAgent(transport=PipecatTransport(url=...))`.

- **Clearer intent:** "PipecatAgent" immediately tells you what you're testing
- **Platform-specific parameters:** Each platform has unique config (LiveKit needs room/token, Twilio needs phone numbers, etc.)
- **Better autocomplete:** IDEs suggest platform-specific options
- **Less nesting:** One level instead of two

**The base class `VoiceAgentAdapter` still exists** for custom implementations. The per-platform classes extend it.

### 7.4 Script interruption API

**Chosen: Layered approach (primitives + sugar + automation)**

Three levels, from explicit to automatic:

| Level | API | Use case |
| --- | --- | --- |
| Primitive | `agent(wait=False)` + `sleep(2)` + `user("...")` | Full control over timing |
| Sugar | `interrupt(after=2, content="...")` | Common case, readable |
| Automated | `proceed(interruptions=InterruptionConfig(...))` | Random/fuzz testing |

This layering means simple tests stay simple, while complex tests have full control.

### 7.5 Judge audio analysis approach

**Chosen: Multimodal LLM with structured timeline**

The judge receives:

1. **Audio** (when model supports it) — for tone, emotion, prosody analysis
2. **Transcript** (always) — for content evaluation
3. **Structured timeline** (always for voice) — for latency, interruption detection

**Alternative considered: Dedicated audio analysis models**

```python
# Rejected: Separate emotion detection model
emotion_scores = await analyze_emotion(audio)  # anger: 0.8, calm: 0.1
```

This is fragile (dedicated models are less capable than multimodal LLMs), adds dependencies, and splits evaluation across multiple systems. GPT-4o listening to the audio directly is more holistic and aligned with how a human would judge.

**Alternative considered: Audio-only judge (no transcript)**

Rejected because transcripts are essential for content evaluation. The judge needs both modalities.

---

## 8. Real-World Pain Points for Customer Support Voice Agents

Beyond the examples above, here are additional scenarios that a voice testing framework should address, derived from real-world voice agent failures:

### The "long hold" problem

User asks something requiring a database lookup. Agent says "Let me check that for you" and goes silent for 30+ seconds. Does the agent play hold music? Give progress updates? The user calls back thinking they were disconnected.

```python
scenario.user("What's my account balance?"),
scenario.agent(),    # Should say "let me look that up" + play hold music
scenario.sleep(15),  # Simulate long tool call time
scenario.agent(),    # Should give the answer
scenario.judge(criteria=["Agent provides audio feedback while waiting"])
```

### The "accent misunderstanding" loop

Agent misunderstands user repeatedly. Instead of offering alternatives (spelling, typing, transfer to human), it keeps asking the same question. Tests whether the agent has an escalation path.

```python
scenario.UserSimulatorAgent(
    voice="elevenlabs/raj_heavy_accent",
    persona="User with heavy accent trying to spell their name",
),
# ...
scenario.judge(criteria=[
    "Agent offers alternative input method after 2 failed attempts",
    "Agent does not loop asking the same question more than 3 times",
])
```

### The "multi-intent" turn

User packs multiple requests into one sentence: "Cancel my subscription and also check if I have any credits left." Voice agents often only address the first intent.

### The "background handoff"

User says "hold on" and talks to someone else in the background. Agent should wait, not respond to the background conversation.

### The "emotional escalation"

User starts calm but gets increasingly frustrated. Agent should detect the shift and adjust its approach (empathy, offer to transfer to human).

---

## 9. TypeScript API Parity

All APIs are mirrored in TypeScript with idiomatic naming:

```tsx
import scenario from "@langwatch/scenario";

const result = await scenario.run({
  name: "billing dispute",
  description: "...",
  agents: [
    scenario.pipecatAgent({ url: "ws://localhost:8765/ws" }),
    scenario.userSimulatorAgent({ voice: "openai/nova" }),
    scenario.judgeAgent({ criteria: ["Agent handles complaint professionally"] }),
  ],
  script: [
    scenario.user("I was charged twice!"),
    scenario.agent(),
    scenario.agent({ wait: false }),
    scenario.sleep(2),
    scenario.user("No, listen to me!"),
    scenario.agent(),
    scenario.judge(),
  ],
});

expect(result.success).toBe(true);
result.audio.save("test-output/billing-dispute.wav");
```

---

## 10. Implementation Phases

### Phase 1: Core Voice Primitives

- `VoiceAgentAdapter` base class with connect/disconnect lifecycle
- TTS integration on `UserSimulatorAgent` (`voice=` parameter)
- `OpenAIRealtimeAgent` (already partially exists)
- Audio message format (standardize the existing `file` content parts)
- `scenario.sleep()`, `scenario.silence()`, `scenario.audio()` script steps
- `ScenarioResult.audio` with save/segments
- Auto-transcription in judge (extend existing `wrapJudgeForAudioTranscription`)

### Phase 2: Platform Integrations

- `PipecatAgent` (WebSocket + WebRTC)
- `LiveKitAgent`
- `TwilioAgent`
- `ElevenLabsAgent`
- `VapiAgent`
- `GeminiLiveAgent`

### Phase 3: Interruptions & Advanced Script Steps

- `agent(wait=False)` async primitive
- `scenario.interrupt()` sugar
- `InterruptionConfig` for `proceed()`
- `interrupt_probability` on UserSimulatorAgent
- `scenario.dtmf()` for telephony

### Phase 4: Audio Effects & Simulation

- Built-in effects pipeline (noise, quality, speed, etc.)
- Bundled noise samples
- Per-step effect overrides
- Accent via TTS voice selection

### Phase 5: Observability & Output

- `VoiceEvent` timeline
- `LatencyMetrics`
- Real-time audio playback during tests
- Full conversation recording
- Integration with LangWatch Simulations Visualizer (audio player in UI)