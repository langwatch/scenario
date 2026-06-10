Feature: OpenAIRealtimeAgentAdapter speaks the GA Realtime wire protocol
  As a developer testing a voice agent against the OpenAI Realtime API
  I want the adapter to use the GA wire protocol instead of the retired beta one
  So that scenario.run() establishes a live session and exchanges turns
  instead of being server-closed with 4000 / beta_api_shape_disabled

  # Issue #602 — the adapter hardcoded the retired `OpenAI-Beta: realtime=v1`
  # header and spoke the beta session/event schema end-to-end. OpenAI removed
  # the beta Realtime interface globally on 2026-05-12 (GA), so every run was
  # rejected. The beta coupling is three layers deep (handshake header →
  # session.update payload → receive-loop event names) plus the module
  # docstring; they must move together (no working intermediate state).
  #
  # Scope guards (NOT changed, per Investigation §3):
  #   - Model constants already GA (gpt-realtime-mini / gpt-4o-transcribe).
  #   - Client→server events unchanged: input_audio_buffer.append/.commit,
  #     conversation.item.create (input_text/input_audio), response.create,
  #     response.cancel.
  #   - User-input transcription event name unchanged in GA
  #     (conversation.item.input_audio_transcription.completed).
  #   - TypeScript adapter unaffected (SDK owns the wire shape).
  # Out of scope: ephemeral client-secret minting; @openai/agents SDK changes;
  # Realtime/transcription model-name changes.

  Background:
    Given an OpenAIRealtimeAgentAdapter constructed with model "gpt-realtime-mini" and voice "alloy"

  # ======================================================================
  # AC1 — GA handshake, no beta header
  # ======================================================================

  @unit
  Scenario: connect() opens the WebSocket with auth only and no OpenAI-Beta header
    # Layer (a): the retired `OpenAI-Beta: realtime=v1` header must be gone.
    Given the adapter has a resolved API key
    When connect() opens the Realtime WebSocket
    Then the handshake sends an "Authorization: Bearer <key>" header
    And the handshake sends no "OpenAI-Beta" header
    And the connect URL is "wss://api.openai.com/v1/realtime?model=gpt-realtime-mini"

  @e2e
  Scenario: A scenario run against the live GA endpoint is no longer rejected at the handshake
    # End-state proof — requires a live OPENAI_API_KEY; cannot be reproduced offline.
    Given a valid OPENAI_API_KEY and the adapter as the agent under test (role=AGENT)
    When a scripted scenario runs via scenario.run()
    Then the server does not close the socket with code 4000 / "beta_api_shape_disabled"
    And the session reaches "session.created" / "session.updated"
    And result.success is True

  # ======================================================================
  # AC2 — GA session.update shape
  # ======================================================================

  @unit
  Scenario: connect() emits a GA-shaped session.update payload
    # Layer (b): audio nested under session.audio.{input,output}; formats as
    # objects; session.type required; voice/transcription/turn_detection relocated.
    When connect() sends the initial session.update
    Then session.type is "realtime"
    And session.audio.input.format is the object {"type": "audio/pcm", "rate": 24000}
    And session.audio.output.format is the object {"type": "audio/pcm", "rate": 24000}
    And session.audio.output.voice is "alloy"
    And session.audio.input.transcription.model is "gpt-4o-transcribe"
    And session.audio.input.turn_detection is null
    And no flat "input_audio_format" or "output_audio_format" string field is present
    And tools and instructions remain top-level under session, not under audio

  @integration
  Scenario: The GA endpoint accepts the session.update with no session.audio error
    # The beta bare-string format produced "Invalid type for
    # 'session.audio.input.format': expected an object, but got a string".
    Given a live GA Realtime session
    When the adapter sends its GA-shaped session.update
    Then no "invalid_request_error" referencing "session.audio.*" is returned

  # ======================================================================
  # AC3 — Audio receive under GA event names
  # ======================================================================

  @unit
  Scenario: recv_audio returns decoded PCM16 from the GA audio-delta event
    # Layer (c): the GA response-output stream name carries the `output_` infix.
    Given the server emits a "response.output_audio.delta" event with base64 PCM16
    When recv_audio is awaited
    Then it returns an AudioChunk whose data is the decoded PCM16 bytes

  @unit
  Scenario: recv_audio defensively accepts the legacy audio-delta name and logs once
    # Live gpt-realtime* may still emit the legacy beta name despite the docs.
    Given the server emits the legacy "response.audio.delta" event with base64 PCM16
    When recv_audio is awaited
    Then it returns an AudioChunk whose data is the decoded PCM16 bytes
    And a one-time log records that the legacy audio-delta name fired

  # ======================================================================
  # AC4 — Transcript observability preserved
  # ======================================================================

  @unit
  Scenario: last_agent_transcript is populated from GA assistant-transcript events
    # role=AGENT turn — GA names carry the `output_` infix.
    Given the server emits "response.output_audio_transcript.delta" events then "response.output_audio_transcript.done"
    When recv_audio processes the events
    Then last_agent_transcript holds the assembled assistant transcript

  @unit
  Scenario: last_user_transcript is populated from the user transcription event
    # role=USER turn — this event name is unchanged in GA.
    Given the server emits "conversation.item.input_audio_transcription.completed" with a transcript
    When recv_audio processes the event
    Then last_user_transcript holds the user transcript text

  # ======================================================================
  # AC5 — Send + interrupt paths intact (client→server events unchanged in GA)
  # ======================================================================

  @unit
  Scenario: Audio send commits the buffer and requests a response under GA
    Given send_audio has appended PCM16 to the input buffer
    When recv_audio runs with pending audio
    Then "input_audio_buffer.append" was sent for the chunk
    And "input_audio_buffer.commit" then "response.create" are sent before awaiting the reply

  @unit
  Scenario: Text send routes a user item then requests a response (role=USER)
    Given the adapter is constructed with role=AgentRole.USER
    When send_text("hello") is called
    Then "conversation.item.create" is sent with a user message containing an "input_text" part "hello"
    And "response.create" is sent immediately after

  @unit
  Scenario: interrupt() cancels the in-flight response under GA
    Given a connected GA session
    When interrupt() is called
    Then "response.cancel" is sent on the socket

  # ======================================================================
  # AC6 — Tests assert the GA contract, not the beta one
  # ======================================================================

  @unit
  Scenario: The adapter unit test asserts the GA session.update shape
    Given python/tests/voice/test_adapters.py
    Then it asserts session.type "realtime" and session.audio.{input,output}.format object shapes
    And it no longer asserts flat "input_audio_format" == "pcm16" or "output_audio_format" == "pcm16"

  @unit
  Scenario: The adapter unit test feeds GA-named server events
    Given python/tests/voice/test_adapters.py mock event streams
    Then the audio-delta fixtures use "response.output_audio.delta"
    And the assistant-transcript fixtures use "response.output_audio_transcript.delta" / ".done"

  @unit
  Scenario: A CI-runnable test fails if the adapter regresses to the beta wire shape
    # The missing guard that let the regression ship — assertable with no live key.
    Given no live OPENAI_API_KEY is available
    When the adapter is regressed to emit a beta-shaped session.update or the beta header
    Then a CI-runnable test fails

  # ======================================================================
  # AC7 — Docstring reflects GA
  # ======================================================================

  @unit
  Scenario: The adapter module docstring documents the GA protocol
    Given the module docstring of python/scenario/voice/adapters/openai_realtime.py
    Then it does not document "OpenAI-Beta: realtime=v1" or "response.audio.delta"
    And it documents the GA endpoint, the auth-only header, and the GA event names

  # --- AC Coverage Map ---
  # AC1 "GA handshake, no beta header" →
  #   Scenario: connect() opens the WebSocket with auth only and no OpenAI-Beta header (@unit)
  #   Scenario: A scenario run against the live GA endpoint is no longer rejected at the handshake (@e2e)
  # AC2 "GA session.update shape" →
  #   Scenario: connect() emits a GA-shaped session.update payload (@unit)
  #   Scenario: The GA endpoint accepts the session.update with no session.audio error (@integration)
  # AC3 "Audio receive under GA event names" →
  #   Scenario: recv_audio returns decoded PCM16 from the GA audio-delta event (@unit)
  #   Scenario: recv_audio defensively accepts the legacy audio-delta name and logs once (@unit)
  # AC4 "Transcript observability preserved" →
  #   Scenario: last_agent_transcript is populated from GA assistant-transcript events (@unit)
  #   Scenario: last_user_transcript is populated from the user transcription event (@unit)
  # AC5 "Send + interrupt paths intact" →
  #   Scenario: Audio send commits the buffer and requests a response under GA (@unit)
  #   Scenario: Text send routes a user item then requests a response (role=USER) (@unit)
  #   Scenario: interrupt() cancels the in-flight response under GA (@unit)
  # AC6 "Tests assert the GA contract, not the beta one" →
  #   Scenario: The adapter unit test asserts the GA session.update shape (@unit)
  #   Scenario: The adapter unit test feeds GA-named server events (@unit)
  #   Scenario: A CI-runnable test fails if the adapter regresses to the beta wire shape (@unit)
  # AC7 "Docstring reflects GA" →
  #   Scenario: The adapter module docstring documents the GA protocol (@unit)
