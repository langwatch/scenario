Feature: Voice agent testing in Scenario SDK
  As a developer testing voice AI agents
  I want to use the same scenario.run() API with voice-capable agents
  So that I can catch the voice-only failure modes that text tests cannot reach
  (interruptions, latency, tone, DTMF, silence, audio-quality robustness)

  Background:
    Given the Scenario SDK is configured
    And voice dependencies are installed as hard deps: imageio-ffmpeg, numpy, webrtcvad-wheels, websockets, twilio, fastapi, uvicorn
    # Note: soundfile, aiortc, livekit, livekit-api, elevenlabs belong to
    # adapters whose transports are deferred (see PR body). They will be
    # added when the corresponding adapter transport ships.
    And openai is already a core dep (reused for default STT, not a new voice dep)
    And optional TTS provider deps (google-cloud-texttospeech, cartesia) are lazy-imported only when their provider prefix is used

  # ======================================================================
  # README — @e2e voice demo isolation requirement (issue #491)
  #
  # The @e2e scenarios below are demonstrated by runnable examples in
  # python/examples/voice/, wrapped by python/tests/voice/test_*_e2e.py, and
  # exercised only by the on-demand voice-integration.yml workflow (they hit
  # live providers and need API keys). python-ci deselects them via
  # `-m "not integration"`.
  #
  # The MULTI-TURN demos (long_hold, accent_loop, emotional_escalation,
  # multi_intent, silence_handling, random_interruptions) additionally carry
  # the `voice_multiturn` pytest marker and MUST run one pytest process each —
  # see TESTING.md "Voice @e2e suite — isolation requirement". Collecting them
  # together in one process wedges teardown (the synchronous LangWatch
  # event-bus drain blocks on telemetry; root cause documented in TESTING.md).
  # Do NOT re-suppress a wedge with @pytest.mark.skip — that leaves the @e2e
  # contract asserted-but-never-run. voice-integration.yml runs each marked
  # demo in its own process instead.
  # ======================================================================

  # ======================================================================
  # Core API — §4.1 Voice Agent Adapters (Source L130-243)
  # ======================================================================

  @unit @ts-pipecat
  Scenario: PipecatAgentAdapter exchanges audio with a Pipecat bot over WebSocket
    # Source §4.1, L137-142 and §5.1, L664-682
    # PR10 of N: TS Pipecat adapter binds this scenario against a fake Twilio
    # Media Streams WS (FakeWebSocket — no network). The real-WSS @integration
    # demo against a live Pipecat bot ships separately once we have an
    # env-gated bot endpoint (see /browser-qa note). The "successful round-trip"
    # asserts: synthetic start handshake, outbound µ-law frames over the
    # wire, inbound µ-law decoded into a PCM16/24k AudioChunk.
    Given a PipecatAgentAdapter configured with url, audio_format "mulaw", sample_rate 8000
    When connect() is called and the SDK sends user audio
    Then a synthetic Twilio Media Streams handshake is performed
    And outbound audio is paced as 20 ms µ-law frames
    And inbound µ-law from the bot is decoded into a PCM16/24kHz AudioChunk
    And the adapter advertises mulaw/8000 as its transport format

  @unit @ts-pipecat
  Scenario: PipecatAgentAdapter raises PendingTransportError on transport="webrtc"
    # Source §4.1, L144-148 and §5.1, L684-700
    # WebRTC (SmallWebRTC) is deferred; calling connect() with transport="webrtc"
    # must raise PendingTransportError immediately so users hit a clear failure
    # mode instead of a silent hang.
    Given a PipecatAgentAdapter configured with signaling_url and transport "webrtc"
    When the scenario executor calls connect()
    Then PendingTransportError is raised naming the adapter and the deferred transport

  @unit @ts-codec
  Scenario: g711 µ-law encode/decode round-trip preserves audio fidelity
    # The g711 codec is the load-bearing math behind every Twilio-protocol
    # adapter (Pipecat over Twilio transport, the upcoming TS Twilio adapter).
    # A known sine wave round-tripped through encode→decode→encode at the same
    # sample rate must preserve amplitude within the per-segment µ-law step.
    Given a PCM16 8 kHz sine wave at known amplitude
    When the buffer is encoded to µ-law and decoded back to PCM16
    Then the round-tripped samples match the input within G.711 quantisation error
    And amplitude is preserved within the per-segment µ-law step

  @unit @ts-codec
  Scenario: g711 sample rate conversion is correct in both directions
    # Pipecat transports run at 8 kHz µ-law; scenario's internal canonical
    # format is PCM16 24 kHz. The 3:1 / 1:3 resampling must round-trip a known
    # signal without large amplitude or DC drift — otherwise inbound audio
    # decays each turn.
    Given a PCM16 24 kHz buffer carrying a known low-frequency tone
    When the buffer is converted 24 kHz → 8 kHz → 24 kHz
    Then the result is approximately 3× shorter then 3× longer
    And no large amplitude or DC offset is introduced

  @unit @ts-pipecat
  Scenario: PipecatAgentAdapter emits a Twilio clear-buffer frame on interrupt
    # Pipecat over the Twilio WS transport speaks Media Streams; the `clear`
    # event drops all buffered outbound audio on the bot side. This is the
    # adapter's first-class interrupt path — preferred over timing-based
    # barge-in because it's deterministic, no VAD detection race.
    Given a connected PipecatAgentAdapter
    When scenario.interrupt() is called on the adapter
    Then a Twilio Media Streams "clear" frame is sent on the WebSocket
    And the frame carries the active streamSid

  @unit
  Scenario: LiveKitAgentAdapter joins a room as a participant
    # Source §4.1, L151-156 and §5.2, L713-731
    Given a LiveKitAgentAdapter with url, api_key, api_secret, room "test-room-123"
    When the scenario executor starts
    Then the adapter joins the room, publishes user-sim audio, and subscribes to the agent track

  @integration
  Scenario: TwilioAgentAdapter places an outbound call
    # Source §4.1, L161-166 and §5.3, L733-758
    Given a TwilioAgentAdapter with phone_number, from_number, account_sid, auth_token
    When the scenario starts
    Then an outbound Twilio call is created and a Media Streams WebSocket is established

  @integration @ts-bound @ts-twilio-proto
  Scenario: TwilioAgentAdapter publishes mulaw/8000 capabilities and clear-buffer interruption
    # PR11 — capability declaration for the Twilio Media Streams transport
    Given a TwilioAgentAdapter constructed with valid credentials and an E.164 phone_number
    Then capabilities.inputFormats and outputFormats both equal ["mulaw/8000"]
    And capabilities.interruption is true (Twilio clear-buffer event)
    And capabilities.dtmf is true

  @integration @ts-bound @ts-twilio-proto
  Scenario: Twilio Media Streams JSON protocol parses start, media, and stop events
    # PR11 — wire-protocol parser bound at unit/integration level
    Given a stream of Twilio Media Streams JSON frames containing "start", "media", and "stop"
    When parseMediaStreamFrame is invoked on each frame
    Then the start frame yields streamSid and callSid
    And the media frame yields decoded mulaw payload bytes
    And the stop frame yields an event with no payload

  @integration @ts-bound @ts-twilio-proto
  Scenario: Twilio interrupt() sends a clear-buffer frame on the live stream
    # PR11 — interrupt path: capabilities.interruption true → send Twilio "clear" event
    Given a TwilioAgentAdapter with a live media stream and a known streamSid
    When interrupt() is awaited
    Then a JSON frame with event "clear" and the streamSid is written to the WebSocket

  @integration @ts-bound @ts-twilio-server
  Scenario: TwiML voice endpoint serves Connect+Stream with an XML-escaped WSS URL
    # PR11 — TwiML response shape, served by the local webhook server
    Given the TwilioWebhookServer is bound on an OS-assigned port
    And the parent adapter has a publicBaseUrl configured
    When a Twilio webhook POSTs valid form data to /twilio/voice
    Then the response Content-Type is application/xml
    And the body contains <Connect><Stream url="wss://..."/></Connect>
    And the stream URL is XML-escaped (no unescaped &, <, >, or quotes)

  @integration @ts-bound @ts-twilio-server
  Scenario: TwiML voice endpoint rejects webhooks with a missing X-Twilio-Signature
    # PR11 — signature gate fails closed for forged or unsigned webhooks
    Given a TwilioWebhookServer with validateSignature true
    When a POST to /twilio/voice arrives without an X-Twilio-Signature header
    Then the response status is 403
    And the adapter records the rejection without opening a media stream

  @e2e @ts-bound @ts-twilio-tunnel
  Scenario: Tunnel exposes the local Twilio server over a public URL
    # PR11 — env-gated e2e: opens an ngrok or localtunnel tunnel and confirms it routes back
    Given NGROK_AUTHTOKEN is set in the environment (otherwise skip)
    And the local TwilioWebhookServer is running on an ephemeral port
    When a TwilioTunnel is opened against the bound port
    Then the tunnel reports an HTTPS URL
    And the URL proxies a GET request through to the local server

  @unit @ts-elevenlabs
  Scenario: ElevenLabsAgentAdapter connects to conversational AI endpoint
    # Source §4.1, L171-174 and §5.4, L760-776
    # Hosted path: ElevenLabs runs the STT→LLM→TTS loop themselves.
    # @ts-elevenlabs so the AND-filter in elevenlabs.test.ts binds this
    # scenario (its connect() handshake unit assertions) — EDR §7.4.
    Given an ElevenLabsAgentAdapter with agent_id and api_key
    When the scenario starts
    Then a WebSocket to wss://api.elevenlabs.io/v1/convai/conversation?agent_id=... is opened
    And PCM16 audio chunks are sent over the socket

  @unit @ts-elevenlabs
  Scenario: Users can compose arbitrary STT + LLM + TTS providers into a voice agent
    # Locked decision #9: composable + branded voice agents
    # Capability AC — no implementation shape prescribed.
    Given an STTProvider implementation, an LLM identifier, and a TTSProvider identifier from any supported providers
    When a user assembles them into a voice agent under test
    Then the assembled agent implements the VoiceAgentAdapter contract
    And the STT, LLM, and TTS seams are independently swappable without changes to the other two
    And intermediate transcripts and LLM decisions are observable by the scenario harness

  @unit @ts-elevenlabs
  Scenario: Provider-branded voice agents expose typed, provider-specific signatures with sensible defaults
    # Locked decision #9: branded wrappers — typing matters, defaults must be opinionated.
    Given a provider-branded voice agent (e.g. an ElevenLabs-branded voice agent)
    When a user instantiates it with only provider-specific required arguments
    Then the branded agent applies opinionated defaults for that provider's STT and TTS
    And the public signature is typed with provider-specific parameter names, not opaque kwargs forwarding
    And it implements the same VoiceAgentAdapter contract as the composable path

  @unit @ts-elevenlabs
  Scenario: Branded voice agents accept overrides for any piece (STT, LLM, or TTS)
    # Locked decision #9: branded is a preset, not a cage — escape hatch is required.
    Given a provider-branded voice agent
    When a user overrides the LLM, STT, or TTS independently
    Then the override takes effect and the other pieces retain their branded defaults

  @unit @ts-elevenlabs
  Scenario: ElevenLabsSTTProvider implements STTProvider and plugs into the composition path
    # Locked decision #9 + existing AC that STT is pluggable.
    Given an ElevenLabsSTTProvider
    Then it implements the STTProvider interface (async transcribe(audio: AudioChunk) -> str)
    And no ElevenLabs-specific types leak into the interface
    And it can be used anywhere an STTProvider is accepted (run({ voice: { stt } }), composable voice agents)

  @unit
  Scenario: VapiAgentAdapter creates a call and connects to websocketCallUrl
    # Source §4.1, L177-180 and §5.5, L778-793
    Given a VapiAgentAdapter with assistant_id and api_key
    When the scenario starts
    Then a call is created via the Vapi REST API
    And the returned websocketCallUrl is connected for bidirectional audio

  @unit @ts-openai-realtime
  Scenario: OpenAIRealtimeAgentAdapter connects as the agent under test
    # Source §4.1, L185-190 and §5.6, L800-813
    Given an OpenAIRealtimeAgentAdapter with model, voice, instructions, tools
    When the scenario starts
    Then a realtime session is established and the model IS the agent

  @unit @ts-openai-realtime
  Scenario: OpenAIRealtimeAgentAdapter with role=AgentRole.USER acts as the user simulator
    # Source §7.2, L1164-1171 (CHOSEN alternative — NOT rejected)
    Given an OpenAIRealtimeAgentAdapter configured with role=AgentRole.USER, voice "nova", instructions "simulate a confused elderly customer"
    When the scenario runs
    Then the realtime model drives the user side of the conversation with natural prosody
    And text TTS is bypassed for the user simulator

  @unit @ts-gemini-live
  Scenario: GeminiLiveAgentAdapter connects via native-audio endpoint
    # Source §4.1, L193-197 and §5.6, L815-826
    Given a GeminiLiveAgentAdapter with model "gemini-2.5-flash-native-audio", voice "Algieba"
    When the scenario starts
    Then a Gemini Live session is established with the given system_instruction

  @unit @ts-gemini-live
  Scenario: GeminiLiveAgentAdapter advertises native-audio capabilities matrix
    # Source §5.6, L815-826 — capability matrix invariants
    Given a GeminiLiveAgentAdapter
    Then capabilities.streaming_transcripts is True
    And capabilities.native_vad is True
    And capabilities.interruption is True
    And capabilities.input_formats include "pcm16/16000"
    And capabilities.output_formats include "pcm16/24000"

  @unit
  Scenario: WebSocketAgentAdapter uses a user-supplied protocol
    # Source §4.1, L202-205 and §5.7, L856-868
    Given a WebSocketAgentAdapter with url and a custom WebSocketProtocol
    When audio is sent
    Then the protocol's encode_audio is used on the wire
    And decode_response is called on inbound messages

  @unit
  Scenario: WebRTCAgentAdapter connects via signaling URL
    # Source §4.1, L208-210
    Given a WebRTCAgentAdapter with signaling_url
    When the scenario starts
    Then a WebRTC peer connection is negotiated

  @unit @ts-adapter
  Scenario: Executor calls connect() before and disconnect() after every scenario
    # Source §4.1, L213-230
    Given any VoiceAgentAdapter subclass
    When scenario.run() starts and completes (success or error)
    Then connect() was awaited exactly once before the first script step
    And disconnect() was awaited exactly once regardless of pass/fail/exception

  @unit @ts-bound @ts-contract-surface
  Scenario: AudioChunk internal format is PCM16 at 24kHz mono
    # Locked decision: AudioChunk normalization
    Given any adapter receives or sends audio
    When the framework normalizes the chunk
    Then the internal AudioChunk is PCM16, 24000 Hz, mono
    And each adapter converts to/from its transport-native format at the send/recv boundary

  # ======================================================================
  # Core API — §4.2 Voice-Enabled User Simulator (Source L244-306)
  # ======================================================================

  @unit @ts-simulator
  Scenario: UserSimulatorAgent without voice is unchanged
    # Source §4.2, L249-250
    Given UserSimulatorAgent(model="openai/gpt-4.1-mini") with no voice parameter
    When the simulator produces a message
    Then the output is a text-only message (existing behavior preserved)

  @unit @ts-simulator
  Scenario: UserSimulatorAgent with voice produces audio messages
    # Source §4.2, L252-256
    Given UserSimulatorAgent(voice="openai/nova")
    When the simulator produces a user turn
    Then the LLM generates text, TTS synthesizes audio, and an audio message is returned

  @unit
  Scenario: TTS voice string follows provider/voice_name format
    # Source §4.2, L271-280 (litellm-style routing)
    Given voice strings "openai/nova", "elevenlabs/rachel", "google/en-US-Neural2-F", "cartesia/sonic-english"
    When the simulator resolves the TTS backend
    Then the provider prefix selects the TTS client
    And the remainder is used as the voice id

  @unit @ts-tts
  Scenario: TTS cache key is (text, voice) only and effects apply after cache hit
    # Locked decision: TTS cache key; Source §7.2 L1158 deterministic caching claim
    Given the same text and voice are used twice with different audio_effects
    When TTS is invoked
    Then the TTS synthesis is cached on (text, voice) and only called once
    And effects are applied to the cached audio after retrieval, never baked in

  @unit @todo
  Scenario: Per-step voice override applies to only that step
    # Source §4.2, L290-294
    # @todo for the AUDIBLE voiceStyle effect — no TTS backend changes timbre
    # by style yet (the simulator emits a one-shot warning). The per-step
    # override PLUMBING (one-turn install + revert) IS wired; covered by
    # script/__tests__/interrupt-after-and-user-overrides.test.ts.
    Given scenario.user("I'm really upset about this!", voice_style="angry")
    When the step runs
    Then the style "angry" is applied only to that turn
    And the simulator's default voice/effects resume on subsequent turns

  @unit @ts-simulator
  Scenario: Per-step audio_effects override applies to only that step
    # Source §4.2, L293
    Given scenario.user("Hello?", audio_effects=[effects.low_volume(0.3)])
    When the step runs
    Then low_volume is applied to only that turn's audio

  @unit @ts-simulator
  Scenario: Persona and audio_effects compose on user simulator
    # Source §4.2, L259-268
    Given UserSimulatorAgent with voice, persona, and audio_effects [background_noise("cafe", 0.2), phone_quality()]
    When multiple turns are produced
    Then every turn's audio has cafe noise and phone-quality filter applied
    And the persona shapes the text content

  # ======================================================================
  # Core API — §4.3 Voice-Enabled Judge (Source L307-364)
  # ======================================================================

  @unit @ts-judge
  Scenario: Judge auto-detects audio messages without configuration
    # Source §4.3, L309-318
    Given JudgeAgent(criteria=[...]) with no audio flags set
    And the conversation contains audio messages
    When the judge evaluates
    Then it auto-enables audio handling

  @unit @ts-judge
  Scenario: Judge always includes transcripts of audio messages
    # Source §4.3, L324 ("Transcripts — automatic STT of all audio messages (always included)")
    Given the conversation has audio turns
    When the judge evaluates
    Then every audio turn has an STT transcript attached to the input

  @unit @ts-judge
  Scenario: Judge passes audio to multimodal models that support it
    # Source §4.3, L325, L362-363 (auto-detect model capability)
    Given JudgeAgent(model="openai/gpt-4o") with audio in the conversation
    When the judge evaluates
    Then the raw audio is passed to the model as multimodal input

  @unit @ts-judge
  Scenario: Judge falls back to transcript-only for non-multimodal models
    # Source §4.3, L362-363
    Given JudgeAgent(model="openai/gpt-4.1-mini") with audio in the conversation
    When the judge evaluates
    Then audio is auto-transcribed and passed as text only

  @unit @ts-judge
  Scenario: Judge receives a structured timeline for voice conversations
    # Source §4.3, L326-345
    Given a voice conversation with speaking/interrupt/tool-call events
    When the judge evaluates
    Then include_timeline defaults to True and a structured timeline is present in AgentInput

  @unit @ts-judge
  Scenario: Judge receives OTel traces when configured
    # Source §4.3, L347, L358
    Given LangWatch/OTel is configured and the conversation contains spans
    When the judge evaluates
    Then include_traces defaults to True and traces are included

  @unit @ts-judge
  Scenario: Explicit include_audio=False forces text-only judge for cost
    # Source §4.3, L353-358
    Given JudgeAgent(include_audio=False) with audio in the conversation
    When the judge evaluates
    Then audio is not passed to the model even if the model supports it

  # ======================================================================
  # Core API — §4.4 Script Extensions (Source L365-494)
  # ======================================================================

  @unit @ts-bound @ts-script-step
  Scenario: agent(wait=False) returns immediately and the agent speaks in background
    # Source §4.4, L369-382
    Given a script with scenario.agent(wait=False) followed by scenario.sleep(2.0)
    When the step runs
    Then control returns before the agent finishes speaking
    And the agent's audio continues streaming during the sleep

  @unit @ts-bound @ts-script-step
  Scenario: scenario.sleep(seconds) pauses the script without touching the transport
    # Source §4.4, L394-406
    Given scenario.sleep(2.0) in a script
    When the step runs
    Then the script pauses 2.0 real seconds
    And no audio is sent on the transport during the pause

  @unit @ts-bound @ts-script-step
  Scenario: scenario.silence(duration) sends silent audio to the transport
    # Source §4.4, L408-417
    Given scenario.silence(5.0) in a script
    When the step runs
    Then 5.0 seconds of PCM16 zero-audio is sent to the agent under test

  @integration @ts-bound @ts-script-step
  Scenario: scenario.dtmf(tones) emits DTMF tones
    # Source §4.4, L419-432 and §5.3
    Given a TwilioAgentAdapter and scenario.dtmf("1") in a script
    When the step runs
    Then the DTMF tone "1" is transmitted through the telephony channel

  @unit @ts-bound @ts-script-step
  Scenario: scenario.audio() injects a WAV file
    # Source §4.4, L434-448
    Given scenario.audio("fixtures/angry_customer_rant.wav") in a script
    When the step runs
    Then the file is loaded, converted to the transport format, and sent as user input
    And the user simulator is bypassed for that turn

  @unit @ts-bound @ts-script-step
  Scenario: scenario.audio() accepts raw bytes
    # Source §4.4, L448
    Given scenario.audio(b"...raw audio bytes...") in a script
    When the step runs
    Then the bytes are converted to the transport format and sent as user input

  @unit @ts-bound @ts-script-step
  Scenario: scenario.audio() supports WAV, MP3, OGG, FLAC
    # Source §4.4, L448
    Given scenario.audio() called with each of .wav, .mp3, .ogg, .flac fixtures
    When each step runs
    Then the file is auto-converted to the transport's format via ffmpeg (bundled)

  @unit @ts-bound @ts-script-step
  Scenario: scenario.interrupt(after=T, content="...") composes wait=False + sleep + user
    # Source §4.4, L450-467
    Given scenario.interrupt(after=2.0, content="Wait, that's wrong!")
    When the step runs
    Then it is equivalent to agent(wait=False) then sleep(2.0) then user("Wait, that's wrong!")

  @unit @ts-bound @ts-script-step
  Scenario: scenario.interrupt(after_words=N) uses streaming transcript when available
    # Source §4.4, L469-476; Locked decision: after_words UnsupportedCapabilityError
    Given the adapter exposes a streaming transcript and after_words=5 is used
    When the agent emits the 5th word
    Then the interrupt content is immediately sent

  @unit @ts-bound @ts-script-step
  Scenario: scenario.interrupt(after_words=N) raises a clear error when adapter lacks streaming transcripts
    # Locked decision: after_words UnsupportedCapabilityError (do not ship built-in STT; document capability matrix)
    Given the adapter does NOT expose a streaming transcript
    When scenario.interrupt(after_words=5) is executed
    Then a clear UnsupportedCapabilityError is raised naming the adapter and the missing capability
    And the error message points to the capability matrix in the docs

  @integration @ts-bound @ts-script-step
  Scenario: proceed(interruptions=InterruptionConfig(...)) injects random interruptions
    # Source §4.4, L478-492
    Given proceed(turns=5, interruptions=InterruptionConfig(probability=0.3, delay_range=(0.5,3.0), strategy="contextual"))
    When proceed runs
    Then ~30% of agent turns are interrupted with contextual LLM-generated phrases
    And delay before each interrupt is sampled uniformly in [0.5, 3.0]

  @integration @ts-bound @ts-interruption-cfg
  Scenario: InterruptionConfig strategy="random_phrase" picks from a canned phrase list
    # Source §4.4, L491
    Given proceed(interruptions=InterruptionConfig(strategy="random_phrase"))
    When proceed runs and interrupts
    Then the interruption content is drawn from the canned phrase list

  # ======================================================================
  # Core API — §4.5 Audio Effects (Source L495-559)
  # ======================================================================

  @unit @ts-effects
  Scenario: Global audio_effects apply to every user-simulator turn
    # Source §4.5, L499-510
    Given UserSimulatorAgent(audio_effects=[effects.background_noise("cafe", 0.3), effects.phone_quality(), effects.packet_loss(0.05)])
    When multiple turns are produced
    Then every turn's audio has all three effects applied in order

  @unit @ts-effects
  Scenario: Each built-in effect from the §4.5 table exists and mutates audio
    # Source §4.5, L517-534 — enumeration contract
    Given the effects module
    Then the following callables exist: background_noise, phone_quality, low_quality, packet_loss, static, echo, speaking_fast, speaking_slow, low_volume, high_volume, robotic, breaking_up, multiple_voices, custom
    And each returns a callable that takes audio bytes and returns audio bytes

  @unit @ts-effects
  Scenario: Custom effect callable wraps user function
    # Source §4.5, L534
    Given effects.custom(fn) where fn takes and returns bytes
    When the effect is applied to a chunk
    Then fn is called with the chunk bytes

  @unit @ts-effects
  Scenario: Accents are handled via TTS voice selection, not post-processing
    # Source §4.5, L536-544 (explicit design note)
    Given a persona requiring an Indian-English accent
    Then the recommended path is voice="elevenlabs/raj_indian_english"
    And no "accent" post-processing effect is provided

  @integration @ts-effects
  Scenario: Effects that vary during conversation via on_turn hook
    # Source §4.5, L548-557
    Given proceed(on_turn=lambda s: s.set_effects([effects.background_noise("cafe", 0.1 * s.current_turn)]))
    When proceed runs for 3 turns
    Then noise volume is 0.1, 0.2, 0.3 on turns 1,2,3 respectively

  # ======================================================================
  # Core API — §4.6 Results & Output (Source L560-627)
  # ======================================================================

  @unit @ts-bound @ts-result-ext
  Scenario: ScenarioResult preserves existing fields
    # Source §4.6, L567-574
    Given a voice scenario completes
    Then result has: success, passed_criteria, failed_criteria, reasoning, messages, total_time, agent_time

  @unit @ts-bound @ts-result-ext
  Scenario: result.audio.save() writes a WAV file of the full conversation
    # Source §4.6, L583-598
    Given a voice scenario result
    When result.audio.save("out.wav") is called
    Then a WAV file containing both speakers' audio is written

  @unit @ts-bound @ts-result-ext
  Scenario: result.audio.save() with format="mp3" writes MP3 via ffmpeg
    # Source §4.6, L586
    Given a voice scenario result
    When result.audio.save("out.mp3", format="mp3") is called
    Then an MP3 file is written using the bundled ffmpeg binary

  @unit @ts-bound @ts-result-ext
  Scenario: result.audio.segments expose per-speaker AudioSegment objects
    # Source §4.6, L588-595
    Given a two-turn voice scenario result
    Then each segment has speaker, start_time, end_time, audio (bytes), transcript

  @unit @ts-bound @ts-result-ext
  Scenario: result.timeline lists VoiceEvent objects in order
    # Source §4.6, L600-615
    Given a voice scenario with interruptions
    Then timeline contains VoiceEvent entries for user_start_speaking, user_stop_speaking, agent_start_speaking, user_interrupt, agent_stop_speaking in time order

  @unit @ts-bound @ts-result-ext
  Scenario: result.latency exposes response-time statistics
    # Source §4.6, L617-625
    Given a voice scenario with multiple agent responses
    Then latency has avg_response_time, p50_response_time, p95_response_time, time_to_first_byte, interrupt_response_time, measurements

  # ======================================================================
  # Core API — §4.7 Real-time Monitoring (Source L628-657)
  # ======================================================================

  @integration
  Scenario: audio_playback=True streams conversation audio during the test
    # Source §4.7, L631-643
    Given scenario.run(..., audio_playback=True)
    When the test runs
    Then audio is played through the local output device in real time

  @unit @ts-hooks
  Scenario: on_audio_chunk hook fires for each chunk
    # Source §4.7, L647-653
    Given scenario.run(..., on_audio_chunk=cb)
    When audio flows
    Then cb is invoked with each AudioChunk

  @unit @ts-hooks
  Scenario: on_voice_event hook fires for each VoiceEvent
    # Source §4.7, L647-653
    Given scenario.run(..., on_voice_event=cb)
    When VAD/interrupt/tool events occur
    Then cb is invoked with each VoiceEvent

  # ======================================================================
  # End-to-End Examples — §6 (one contract AC per example, Example 6.5 not optional)
  # Per TESTING.md: @e2e = happy paths via real examples, no mocks.
  # Each scenario is backed by a runnable python/examples/voice_*.py file.
  # ======================================================================

  @e2e
  Scenario: Example 6.1 — basic greeting flow
    # Source §6.1, L874-899
    Given a PipecatAgentAdapter, a voice UserSimulator (openai/nova), a JudgeAgent with greeting criteria
    And a script: agent(), user("Hi, I need some help"), agent(), judge()
    When the scenario runs
    Then result.success is True
    And result.audio.save() writes a WAV

  @e2e
  Scenario: Example 6.2 — interruption recovery
    # Source §6.2, L901-929
    Given a voice scenario with agent(wait=False), sleep(2.0), user("Wait sorry, I meant Chicago, not LA")
    When the scenario runs
    Then result.success is True
    And result.latency.interrupt_response_time < 1.0

  @e2e
  Scenario: Example 6.3 — angry customer in noisy cafe
    # Source §6.3, L931-967 and §8 emotional escalation
    Given UserSimulatorAgent(voice="elevenlabs/rachel", persona="Very angry customer...", effects=[background_noise("cafe", 0.4), phone_quality()])
    When the scenario runs multiple turns
    Then the judge evaluates empathy, noise-robustness, and resolution

  @e2e
  Scenario: Example 6.4 — DTMF IVR navigation
    # Source §6.4, L969-996
    Given a TwilioAgentAdapter and a script using scenario.dtmf("1")
    When the scenario runs
    Then the agent routes to billing and result.success is True

  @e2e
  Scenario: Example 6.5 — tool call verification as a plain Python step
    # Source §6.5, L998-1028 — CALLABLE AS SCRIPT STEP PATTERN
    Given a function assert_tool_called(state) that raises if no get_customer_info tool_call event exists
    And a script containing user(...), agent(), assert_tool_called, user(), agent(), judge()
    When the scenario runs
    Then the plain Python callable is invoked with ScenarioState at its position
    And state.timeline is available and contains the tool_call event

  @e2e
  Scenario: Example 6.6 — pre-recorded audio injection
    # Source §6.6, L1030-1055
    Given scenario.audio("fixtures/mumbly_inaudible_question.wav") as the first step
    When the scenario runs
    Then the judge evaluates whether the agent asks for clarification

  @e2e
  Scenario: Example 6.7 — random interruptions via interrupt_probability
    # Source §6.7, L1057-1085
    Given UserSimulatorAgent(interrupt_probability=0.4) and proceed(turns=5)
    When the scenario runs
    Then interruptions occur roughly 40% of agent turns
    And the judge evaluates recovery and context preservation

  @e2e
  Scenario: Example 6.8 — silence handling
    # Source §6.8, L1087-1113
    Given a script with user(...), silence(10.0), agent(), user(...), agent(), judge()
    When the scenario runs
    Then the agent prompts during silence and result.success is True

  # ======================================================================
  # Real-World Pain Points — §8 (ACs for the 5 failure patterns, L1227-1271)
  # Per TESTING.md: @e2e = happy paths via real examples.
  # Each scenario is backed by a runnable python/examples/voice_pain_*.py file.
  # ======================================================================

  @e2e
  Scenario: Pain pattern — "long hold" feedback during 15s tool call
    # Source §8 L1231-1241
    Given a script: user("What's my account balance?"), agent(), sleep(15), agent()
    When the scenario runs
    Then the judge checks "Agent provides audio feedback while waiting"

  @e2e
  Scenario: Pain pattern — "accent misunderstanding" loop escape
    # Source §8 L1243-1257
    Given a user simulator with a heavy-accent voice spelling their name
    When the scenario runs several turns
    Then the judge checks the agent offers an alternative input method after 2 failed attempts
    And does not loop the same question more than 3 times

  @e2e
  Scenario: Pain pattern — "multi-intent" single turn
    # Source §8 L1259-1261
    Given the user says "Cancel my subscription and also check if I have any credits left"
    When the scenario runs
    Then the judge checks both intents are addressed in the agent's response

  @e2e
  Scenario: Pain pattern — "background handoff" should not trigger agent response
    # Source §8 L1263-1265
    Given the user says "hold on" then emits overheard-conversation audio as background
    When the scenario runs
    Then the judge checks the agent waits rather than responding to the background audio

  @e2e
  Scenario: Pain pattern — "emotional escalation" detection and adjustment
    # Source §8 L1267-1269
    Given a user simulator whose persona escalates from calm to frustrated over turns
    When the scenario runs
    Then the judge checks the agent detects the shift and offers empathy or human escalation

  # ======================================================================
  # End-to-End Platform Demos — per adapter with real transports
  # Per TESTING.md: @e2e = happy paths via real examples, no mocks.
  # Each scenario is backed by a runnable python/examples/voice_*.py file
  # exercising the shipped real transport end-to-end.
  # ======================================================================

  @e2e @ts-e2e
  Scenario: Round-trip audio fidelity gate — utterance survives TTS → bus → STT
    # Source: docs/adr/003-voice-internal-design.md §8 — the runnable top-of-stack
    # gate. The REGRESSION GUARD for the Gap #3 LIVE BUG: the two audio
    # producers tag PCM differently (format:"wav" vs format:"pcm16") and
    # their extractors decode by tag, so a format mismatch surfaces as a
    # GARBLED transcript on the far side. Per-PR unit tests each exercise
    # only their own producer/extractor pair and miss the seam; this drives
    # a known utterance through the real seam end-to-end and asserts the
    # far-side transcript matches the input within a word-level tolerance.
    # Self-contained on OPENAI_API_KEY (user-sim TTS + judge STT both OpenAI).
    Given a known user utterance and OPENAI_API_KEY
    When the utterance is synthesized by the user-sim TTS, carried on the message bus, and transcribed by the judge STT
    Then the far-side transcript matches the input utterance within tolerance

  @e2e @ts-pipecat-demo
  Scenario: Demo — Pipecat WebSocket adapter happy path
    # Covers: PipecatAgentAdapter real WS transport (shipped) + simulator + judge
    Given a local Pipecat bot on ws://localhost:8765/ws and a PipecatAgentAdapter
    When the demo script runs via scenario.run()
    Then result.success is True
    And the recording contains both user-sim and agent audio

  @e2e @ts-elevenlabs
  Scenario: Demo — ElevenLabs hosted Conversational AI
    # Covers: ElevenLabsAgentAdapter real WS transport (§5.4) + simulator + judge
    Given an ElevenLabsAgentAdapter with a live agent_id and ELEVENLABS_API_KEY
    When the demo script runs via scenario.run()
    Then the WS reaches wss://api.elevenlabs.io/v1/convai/conversation
    And result.success is True after ≥2 exchanges

  @e2e @ts-elevenlabs
  Scenario: Demo — ElevenLabs composable + branded agent
    # Covers: ComposableVoiceAgent + ElevenLabsVoiceAgent + ElevenLabsSTTProvider (locked decision #9)
    Given an ElevenLabsVoiceAgent with branded defaults (ElevenLabsSTTProvider, elevenlabs/rachel TTS)
    When the demo script runs via scenario.run()
    Then the STT, LLM, and TTS seams each fire at least once
    And result.success is True

  @e2e @ts-gemini-live-e2e
  Scenario: Demo — Gemini Live native audio
    # Covers: GeminiLiveAgentAdapter real transport + simulator + judge
    Given a GeminiLiveAgentAdapter with model "gemini-2.5-flash-native-audio" and GEMINI_API_KEY
    When the demo script runs via scenario.run()
    Then a live session is established and result.success is True

  @e2e @ts-openai-realtime-agent-demo
  Scenario: Demo — OpenAI Realtime as the agent under test
    # Covers: OpenAIRealtimeAgentAdapter (role=AGENT) end-to-end
    Given an OpenAIRealtimeAgentAdapter with role=AgentRole.AGENT and OPENAI_API_KEY
    When the demo script runs via scenario.run()
    Then the model plays the agent role and result.success is True

  @e2e @ts-openai-realtime-user-demo
  Scenario: Demo — OpenAI Realtime as the user simulator
    # Covers: OpenAIRealtimeAgentAdapter(role=AgentRole.USER) natural-prosody simulator
    Given an OpenAIRealtimeAgentAdapter with role=AgentRole.USER and a confused-elderly-customer persona
    When the demo script runs via scenario.run()
    Then scripted user("text") lines are delivered with natural prosody
    And text TTS is bypassed for the user simulator

  @e2e
  Scenario: Demo — Twilio inbound (human dials in)
    # Covers: TwilioAgentAdapter.wait_for_call() real-phone happy path
    Given a TwilioAgentAdapter in answer mode with a tunneled Media Streams webhook
    When a human dials the configured number during the demo run
    Then the Media Streams WS opens and result.success is True after one turn

  @e2e
  Scenario: Demo — Twilio outbound (agent calls a human)
    # Covers: TwilioAgentAdapter.place_call() real-phone happy path
    Given a TwilioAgentAdapter and a destination phone number
    When the demo script runs scenario.run() and place_call() dials out
    Then the callee answers and the Media Streams WS opens
    And result.success is True after one turn

  # ======================================================================
  # End-to-End Cross-cutting SDK Features
  # Per TESTING.md: @e2e = happy paths via real examples. These demos prove
  # first-class SDK features work via a runnable script, not just in isolation.
  # ======================================================================

  @e2e @ts-recording-playback
  Scenario: Demo — recording and playback
    # Covers: result.audio.save() (WAV + MP3 via ffmpeg) + audio_playback=True live stream
    Given a voice scenario run with audio_playback=True
    When the demo script finishes and calls result.audio.save("demo.wav") and result.audio.save("demo.mp3")
    Then both files exist on disk with non-zero duration
    And ffplay was spawned at least once during live playback

  @e2e
  Scenario: Demo — observability hooks and latency metrics
    # Covers: on_audio_chunk + on_voice_event callbacks and LatencyMetrics (TTFB, p50/p95)
    Given a voice scenario run wired with on_audio_chunk and on_voice_event callbacks
    When the demo script completes
    Then both callbacks fired at least once per turn
    And result.latency exposes time_to_first_byte, p50, and p95

  @e2e @ts-stt-swap
  Scenario: Demo — STT provider swap via run({ voice: { stt } })
    # Covers: pluggable STTProvider (default OpenAI → ElevenLabsSTTProvider in demo)
    # Per-run, not a global (ADR-002): run({ voice: { stt } }) replaces the
    # removed scenario.configure(stt=...) API.
    Given a voice scenario run with run({ voice: { stt: ElevenLabsSTTProvider(...) } })
    When the demo script runs and the audio turn is auto-transcribed for the judge
    Then the ElevenLabsSTTProvider.transcribe() path was exercised (not the default)
    And result.success is True

  @e2e @ts-voice-text-parity
  Scenario: Demo — same scenario.run() entrypoint for voice and text
    # Covers: text-only scenario still works; voice scenario same entrypoint/script shape
    Given two scenarios sharing an identical script and judge, differing only in agents
    When both are executed via scenario.run()
    Then both result.success are True
    And no voice imports are loaded in the text-only run

  # ======================================================================
  # Interruption / barge-in demos — the flagship voice-only capability (§6.2,
  # §6.7, §4.4). Each is a MULTI-TURN conversation that fires a real barge-in.
  # Mirrors python/examples/voice/{interruption_recovery,random_interruptions,
  # elevenlabs_interruption,gemini_live_interruption}.py.
  # ======================================================================

  @e2e @ts-interruption-recovery-demo
  Scenario: Demo — interruption recovery (barge-in via agent({ wait: false }) + interrupt())
    # Covers §6.2: user interrupts the agent mid-utterance twice (unrolled
    # agent({wait:false})+user, then the interrupt() sugar); the agent recovers.
    Given a local Pipecat bot on ws://localhost:8765/stream that supports barge-in
    When the demo script interrupts the agent mid-utterance and the agent recovers
    Then the agent recovered and the conversation is multi-turn
    And the agent reply was actually cut off and then recovered

  @e2e @ts-random-interruptions-demo
  Scenario: Demo — random interruptions via interruptProbability + voiceProceed
    # Covers §6.7: UserSimulatorAgent({interruptProbability}) + voiceProceed({turns,
    # interruptions: InterruptionConfig({...})}) injects barge-ins across the run.
    #
    # What this proves: probabilistic barge-in fires (user_interrupt event) with a
    # fired_after_speech outcome (timing correct), canned-phrase strategy ran (user
    # segment carries a phrase from the pool), cut-off-boundary LABEL fires
    # (transcriptTruncated on at least one agent seg), and the bot recovers.
    #
    # What this does NOT prove: real audio-level mid-stream cut-off. The bundled
    # Pipecat stub bot generates TTS in a burst and streams faster than realtime —
    # by the time adapter.interrupt() runs all frames are already sent. The segment
    # plays in full but is correctly LABELED at the interrupt boundary. For REAL
    # audio truncation see the gemini-live-interruption scenario (server-side cancel).
    Given a user simulator with interruptProbability and voiceProceed({ interruptions })
    When the multi-turn demo script runs via scenario.run()
    Then at least one barge-in fired mid-utterance and the canned-phrase strategy ran
    And the agent recovered with non-empty audio after the last interrupt
    And the conversation involved multiple turns

  @e2e @ts-elevenlabs-interruption-demo
  Scenario: Demo — ElevenLabs interruption (server VAD barge-in)
    # Covers: ElevenLabs ConvAI has no client cancel — server VAD detects the
    # overlap and cuts the agent's reply when user audio arrives mid-utterance.
    Given a hosted ElevenLabs ConvAI agent and a mid-utterance interrupt()
    When the demo script runs via scenario.run()
    Then the agent's reply was cut off and it pivoted to the new topic

  @e2e @ts-gemini-live-interruption-demo
  Scenario: Demo — Gemini Live interruption (server VAD barge-in)
    # Covers: Gemini Live has no client cancel — server VAD detects the overlap
    # and cuts the agent's reply when user audio arrives mid-utterance.
    Given a Gemini Live agent and a mid-utterance interrupt()
    When the demo script runs via scenario.run()
    Then the agent's first reply was cut off mid-utterance by the barge-in

  # ======================================================================
  # Persona / pain-pattern + greeting + pipecat-scenario demos (§6.1, §6.3, §8).
  # Mirrors python/examples/voice/{basic_greeting,angry_customer,
  # background_handoff,pipecat_scenario}.py.
  # ======================================================================

  @e2e @ts-basic-greeting-demo
  Scenario: Demo — basic greeting flow (multi-turn)
    # Covers §6.1: greeting → user → agent → user → agent → judge over the bot.
    Given a local Pipecat bot and a voice user simulator
    When the multi-turn greeting demo runs via scenario.run()
    Then result.success is True and the recording has both speakers

  @e2e @ts-angry-customer-demo
  Scenario: Demo — angry customer in a noisy cafe (multi-turn)
    # Covers §6.3: persona + audioEffects (backgroundNoise + phoneQuality) over
    # a multi-turn conversation; judge evaluates empathy + noise-robustness.
    Given a very-angry user simulator with backgroundNoise + phoneQuality effects
    When the multi-turn demo runs via scenario.run()
    Then the agent stays calm, noise is audibly mixed, and the judge passes

  @e2e @ts-background-handoff-demo
  Scenario: Demo — background handoff should not trigger agent response
    # Covers §8 pain pattern: user says "hold on", goes silent, then returns;
    # the agent should wait rather than respond to the gap.
    Given a user simulator that hands off mid-call (silence) then returns
    When the multi-turn demo runs via scenario.run()
    Then result.success is True and the recording spans the handoff

  @e2e @ts-pipecat-scenario-demo
  Scenario: Demo — Pipecat scenario smoke (multi-turn)
    # Covers: the pipecat_scenario.py twin — multi-turn smoke over the live bot.
    Given a local Pipecat bot on ws://localhost:8765/stream
    When the multi-turn smoke demo runs via scenario.run()
    Then the recording contains both user-sim and agent audio across turns

  # ======================================================================
  # Architectural Guarantees (Source §1 L9, §3 L107-124, §7 L1175-1186)
  # ======================================================================

  @unit
  Scenario: Voice tests use the same scenario.run() entrypoint as text tests
    # Source §1 L9 — "no scenario.voice.run(), no separate paradigm"
    Given any voice scenario
    Then it is invoked via scenario.run(), not via a voice-specific entrypoint

  @unit
  Scenario: Existing text-only scenarios are unaffected by voice dependencies
    # Source §3 L116-124 (what stays the same)
    Given a text-only scenario with no voice adapters or voice= parameter
    When it runs
    Then no TTS, STT, ffmpeg, or transport code is invoked
    And behavior is identical to pre-voice SDK

  @unit @ts-bound @ts-contract-surface
  Scenario: VoiceAgentAdapter base class is public for custom implementations
    # Source §7.3 L1186, §5.7 L830-854
    Given a user subclass of VoiceAgentAdapter implementing connect/send_audio/recv_audio/disconnect
    When plugged into scenario.run()
    Then it works identically to built-in adapters

  @unit
  Scenario: Hard dependencies install with the SDK (no extras flag)
    # Locked decision: Hard deps — voice is first-class
    Given "pip install scenario"
    Then imageio-ffmpeg, numpy, webrtcvad-wheels, websockets, twilio, fastapi, uvicorn are installed as hard deps
    # soundfile, aiortc, livekit, livekit-api, elevenlabs ship with the adapters whose
    # transports need them (see follow-up issues linked from PR #355).
    And google-cloud-texttospeech and cartesia are NOT installed by default (lazy-imported when their provider prefix is used)
    And ffmpeg binary is available via imageio_ffmpeg.get_ffmpeg_exe()
    And bundled noise WAV samples (cafe, street, office, airport for background_noise; babble for multiple_voices) ship inside the package

  # ======================================================================
  # Pluggable STT (provider-agnostic by design)
  # ======================================================================

  @unit @ts-stt
  Scenario: Default STT provider is OpenAI gpt-4o-transcribe
    Given no per-run STT override is set on run({ voice: { stt } })
    And a conversation contains an audio turn
    When the audio is auto-transcribed and the judge receives text
    Then the SDK uses openai.audio.transcriptions with model "gpt-4o-transcribe"

  @unit @ts-stt
  Scenario: Users swap STT providers via run({ voice: { stt } })
    Given a custom STTProvider implementation
    When run({ voice: { stt: CustomProvider() } }) is used
    And the audio is auto-transcribed and the judge receives text
    Then the custom provider's transcribe() is invoked instead of the default

  @unit @ts-stt
  Scenario: STT provider interface is minimal and provider-agnostic
    Given the STTProvider abstract base class
    Then it defines async transcribe(audio: AudioChunk) -> str
    And no OpenAI-specific types leak into the interface

  @unit @ts-stt
  Scenario: Transcription chunks audio longer than 25 minutes
    # OpenAI gpt-4o-transcribe has a 25-minute per-request limit
    Given an audio turn exceeding 25 minutes in the default STT provider
    When transcription is requested
    Then the audio is split into chunks under the limit and concatenated

  # ======================================================================
  # Adapter Capability Matrix — new requirement
  # ======================================================================

  @unit @ts-bound @ts-contract-surface
  Scenario: Every adapter publishes a capabilities attribute
    Given any concrete VoiceAgentAdapter subclass
    Then adapter.capabilities is an AdapterCapabilities instance
    And it declares: streaming_transcripts, native_vad, dtmf, interruption, input_formats, output_formats

  @unit @ts-bound @ts-contract-surface
  Scenario: dtmf() raises UnsupportedCapabilityError on non-telephony adapters
    Given an adapter with capabilities.dtmf == False
    When scenario.dtmf("1") runs
    Then UnsupportedCapabilityError is raised naming the adapter and the "dtmf" capability

  @unit @docs
  Scenario: Capability matrix is rendered into adapter docs
    Given the voice-agents documentation
    Then a capability matrix table lists every built-in adapter
    And each row shows streaming_transcripts, native_vad, dtmf, input/output formats

  # ======================================================================
  # VAD Fallback
  # ======================================================================

  @unit @ts-vad
  Scenario: SDK-side VAD fallback activates on adapters without native VAD
    Given an adapter with capabilities.native_vad == False
    When a voice scenario runs and audio flows
    Then user_start_speaking and user_stop_speaking VoiceEvents are still emitted
    And webrtcvad-wheels is used to detect speaker boundaries

  @unit @ts-vad
  Scenario: VAD fallback emits a one-shot UserWarning on first activation
    Given an adapter with capabilities.native_vad == False
    When the scenario starts and VAD fallback is used
    Then a UserWarning is issued exactly once per process naming the adapter
    And the warning text references accuracy differences vs native VAD

  @unit @ts-vad
  Scenario: Adapters with native VAD do not trigger the fallback
    Given an adapter with capabilities.native_vad == True
    When the scenario runs
    Then webrtcvad is not invoked
    And VAD events come from the adapter's native stream

  # ======================================================================
  # Local Playback (ffmpeg subprocess with audio-output driver)
  # ======================================================================

  @unit
  Scenario: audio_playback=True spawns ffmpeg as a subprocess with audio-output driver
    Given scenario.run(..., audio_playback=True)
    When audio flows
    Then an ffmpeg subprocess is started using the bundled binary from imageio-ffmpeg
    And the subprocess is invoked with a platform-appropriate audio-output driver (e.g., -f alsa, -f coreaudio, -f dshow)
    And no sounddevice/PortAudio dependency is imported
    And ffplay is NOT used (imageio-ffmpeg does not bundle ffplay)

  @unit
  Scenario: Playback degrades gracefully on headless systems
    Given audio_playback=True on a system with no audio output device
    When the ffmpeg subprocess fails to open the device
    Then the scenario continues without raising
    And a debug-level log message is emitted
    And result.audio is still populated

  # ======================================================================
  # Audio in any role — type-level fix (adaptability note)
  # ======================================================================

  @unit @ts-assistant-role
  Scenario: Audio content works cleanly in assistant-role messages
    # Fixes the forceUserRole workaround in javascript/examples/vitest/tests/helpers/openai-voice-agent.ts
    Given a conversation with an assistant-role message containing audio content
    When the judge processes the conversation
    Then no role rewriting is needed
    And no "forceUserRole" style workaround exists anywhere in the Python SDK

  # ======================================================================
  # Voice demo recordings (per-segment + full + manifest)
  # ======================================================================

  @unit
  Scenario: Saving segments writes per-segment WAVs, full mix, and manifest
    Given a VoiceRecording with two segments (user, then agent)
    When save_segments is called with a target directory
    Then the target directory contains a segments/ subdirectory with two WAV files
    And the target directory contains a full.wav file
    And the target directory contains a manifest.json with segment_count 2
    And each manifest entry's file path resolves to a real WAV on disk

  @integration
  Scenario: Demo opt-in writes recordings under python/outputs/recordings/<demo>/
    Given any voice_*.py demo runs to completion and produces result.audio
    When the demo's main() calls save_demo_recording(result.audio, "<demo_name>")
    Then a directory python/outputs/recordings/<demo_name>/ is created
    And it contains segments/, full.wav, and manifest.json

  @integration
  Scenario: CI uploads recordings as a workflow artifact
    Given the voice-integration workflow runs
    Then it uploads python/outputs/recordings/** as the "voice-demo-recordings" artifact
    And the upload step runs even when prior steps fail (if: always())

  # ======================================================================
  # Auto-transcribe agent audio for non-multimodal judges
  # ======================================================================

  @unit @ts-transcribe
  Scenario: transcribe_segments fills missing transcripts in place
    Given a VoiceRecording with two agent segments lacking transcripts
    When transcribe_segments is called with a configured STT provider
    Then both segments have non-null transcript
    And segments that already had a transcript are not re-transcribed

  @unit
  Scenario: judge auto-transcribes agent audio when model is non-multimodal
    Given a voice scenario whose judge uses a text-only model
    And the conversation contains an assistant message with audio content only
    When the judge runs
    Then transcribe_segments is invoked over result.audio
    And the judge's transcript view contains the agent's spoken text

  @unit @ts-transcribe
  Scenario: missing STT provider degrades gracefully
    Given transcribe_segments is called with no configured STT provider
    Then it logs a warning and returns without raising
    And segment transcripts remain null

  # ======================================================================
  # Audio messages render cleanly in the terminal
  # ======================================================================

  @unit
  Scenario: print_openai_messages renders audio with transcript as speaker icon plus italic text
    Given a message with multimodal content containing an input_audio part
    And the message also includes a text transcript part
    When print_openai_messages is called for the message
    Then the printed output starts the audio with the 🔊 speaker icon
    And the transcript is rendered in italic
    And no base64-encoded WAV data appears in the output

  @unit
  Scenario: print_openai_messages renders audio-only parts as "🔊 (audio)"
    Given a message with multimodal content containing only an input_audio part
    When print_openai_messages is called for the message
    Then the printed output contains "🔊 (audio)"
    And no base64-encoded WAV data appears in the output

  @unit
  Scenario: text-only multimodal content still prints normally
    Given a message with multimodal content containing only a text part
    When print_openai_messages is called for the message
    Then the printed output contains the text without the speaker icon or italics
