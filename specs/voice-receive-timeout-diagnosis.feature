Feature: receiveAudio response-timeout budget and timeout diagnosis
  As a developer testing a hosted ElevenLabs ConvAI agent
  I want the same response budget in both SDKs, and a timeout that says which
  deadline expired and how to move it
  So that a merely slow agent does not fail in TypeScript while passing in
  Python, and so the error points at the fix instead of at four checks that are
  already correct

  Background:
    Given receiveAudio bounds one turn with an IDLE deadline of responseTimeout,
      re-armed by every inbound frame including keepalive pings until the agent
      has spoken this turn, and after that only by agent audio or tool activity
    And an ABSOLUTE ceiling of max(responseTimeout, KEEPALIVE_HARD_CEILING_S)
      that no inbound frame re-arms
    And the ElevenLabsAgentAdapter is constructed with a webSocketFactory that
      injects a FakeWebSocket, connected, and driven under fake timers

  # ============================================================
  # Group: Cross-SDK budget parity
  # ============================================================

  @unit
  Scenario: The TypeScript response budget equals the Python one
    Given VoiceAgentAdapter.response_timeout is 60.0 in Python
    Then VoiceAgentAdapter.responseTimeout is 60.0 in TypeScript
    And the runtime fallback used when an adapter nulls the field is also 60

  @unit
  Scenario: An agent that answers inside the default budget is not failed
    Given a connected adapter left at its default responseTimeout
    When receiveAudio is called and no frame arrives for 35 seconds
    And an audio frame then arrives
    Then the promise resolves with that audio
    And no rejection occurred at the former 30 second budget

  # ============================================================
  # Group: Which deadline expired
  # ============================================================

  @unit
  Scenario: A fully silent agent reports the idle deadline
    Given a connected adapter left at its default responseTimeout
    When receiveAudio is called and no frame of any kind arrives
    Then the promise rejects once the idle deadline elapses
    And the message reports the idle deadline and the seconds it waited
    And the message states that not even a keepalive ping arrived
    And the message names responseTimeout as the way to wait longer
    And the message links the troubleshooting anchor
      receiveaudio-timed-out-hosted-elevenlabs
    And the message does not describe the absolute ceiling, even though at the
      default budget both deadlines land on the same instant

  @unit
  Scenario: A pinging but speechless agent reports the absolute ceiling
    Given a connected adapter left at its default responseTimeout
    When receiveAudio is called and ping frames keep arriving inside the idle
      deadline while no audio ever does
    Then the promise rejects once the absolute ceiling elapses
    And the message reports the absolute ceiling and the seconds it waited
    And the message explains that pings re-arm the idle deadline
    And the message names responseTimeout as the way to raise the ceiling
    And the message does not describe the idle deadline

  # ============================================================
  # Group: The knob still works
  # ============================================================

  @unit
  Scenario: A raised responseTimeout moves the idle deadline
    Given a connected adapter whose responseTimeout is set to 90
    When receiveAudio is called and no frame of any kind arrives
    Then no rejection occurs at 60 seconds
    And the rejection at 90 seconds reports an idle deadline of 90s

  @unit
  Scenario: A raised responseTimeout moves the absolute ceiling with it
    Given a connected adapter whose responseTimeout is set to 90
    When receiveAudio is called and ping frames keep arriving inside the idle
      deadline while no audio ever does
    Then no rejection occurs at the 45 second ceiling floor
    And the rejection reports an absolute ceiling of 90s

  @unit
  Scenario: A sub-second tail probe keeps the 45 second ceiling floor
    Given a connected adapter and a receiveAudio call with the 0.6s tail-probe
      timeout the drain uses
    When ping frames keep arriving and no audio ever does
    Then the rejection reports an absolute ceiling of 45s, not 0.6s

  # ============================================================
  # Group: The turn ends when the agent's audio stops
  #
  # The tool scenarios assume the agent sends agent_tool_request and
  # agent_tool_response, which ElevenLabs does only when both are enabled in
  # the agent's client events. Without them a tool is invisible: a tool longer
  # than the tail ends the turn, like any other gap in the agent's audio.
  #
  # JS tests use the numbers below. Python tests run the same steps with the
  # timings scaled down (a 0.1s tail, frames every 30ms, a patched ceiling).
  # ============================================================

  @unit
  Scenario Outline: Non-audio frames after the agent spoke do not hold the turn open
    Given a connected adapter whose agent has spoken one audio chunk this turn
    When the drain probes with the 0.6s tail-silence timeout
    And <frame> frames keep arriving every 200ms with no further audio
    Then the probe rejects on its 0.6s idle deadline within one second
    And the turn does not wait for the 45 second ceiling

    Examples:
      | frame                    |
      | ping                     |
      | vad_score                |
      | context_usage            |
      | agent_chat_response_part |

  @unit
  Scenario: More agent audio keeps the turn open
    Given a connected adapter whose agent has spoken one audio chunk this turn
    When the drain probes with the 0.6s tail-silence timeout
    And another agent audio chunk arrives
    Then the probe resolves with that audio

  @unit
  Scenario: A server tool the agent started keeps the turn open while it runs
    Given a connected adapter whose agent has spoken one audio chunk this turn
    When the drain probes with the 0.6s tail-silence timeout
    And an agent_tool_request arrives and only pings follow for 5 seconds
    Then the probe is still open

  @unit
  Scenario: A silent tool keeps the turn open without pings
    Given a connected adapter whose agent has spoken one audio chunk this turn
    When the drain probes with the 0.6s tail-silence timeout
    And an agent_tool_request arrives and nothing else arrives for 5 seconds
    Then the probe is still open

  @unit
  Scenario: The turn waits for the spoken answer after the tool answers
    Given a connected adapter whose agent has spoken one audio chunk this turn
    When the drain probes with the 0.6s tail-silence timeout
    And an agent_tool_request and its agent_tool_response arrive
    And only pings arrive every 100ms for 900ms
    And then the agent's answer audio arrives
    Then the probe resolves with that audio

  @unit
  Scenario: The tail probe returns once the post-tool answer has started
    Given a connected adapter whose agent spoke, ran a tool, and spoke its answer
    When the drain probes with the 0.6s tail-silence timeout
    And only pings keep arriving every 200ms
    Then the probe rejects on its 0.6s idle deadline

  @unit
  Scenario: The post-tool wait is bounded when the agent never speaks again
    Given a connected adapter whose agent has spoken one audio chunk this turn
    When the drain probes with the 0.6s tail-silence timeout
    And an agent_tool_request and its agent_tool_response arrive
    And only pings keep arriving, with no further audio
    Then the probe rejects on the 45 second absolute ceiling

  @unit
  Scenario: A new user turn restores ping liveness for the wait before the answer
    Given a connected adapter whose agent has spoken one audio chunk
    When the user sends the next turn's audio
    And a 0.6s receive is open while only pings arrive every 200ms for 2 seconds
    Then the receive is still open

  @unit
  Scenario: A receive that ends on a deadline reports what it saw
    Given any receiveAudio that ends on its idle deadline or its ceiling
    Then the active receive span carries the end kind, the wait, how late the
      deadline fired, and the count of each inbound EL message type, in both SDKs
    And a ceiling end, or a deadline that fired more than a second late, is
      logged as a warning
