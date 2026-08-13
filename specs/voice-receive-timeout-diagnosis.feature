Feature: receiveAudio response-timeout budget and timeout diagnosis
  As a developer testing a hosted ElevenLabs ConvAI agent
  I want the same response budget in both SDKs, and a timeout that says which
  deadline expired and how to move it
  So that a merely slow agent does not fail in TypeScript while passing in
  Python, and so the error points at the fix instead of at four checks that are
  already correct

  Background:
    Given receiveAudio bounds one turn with an IDLE deadline of responseTimeout,
      re-armed by every inbound frame including keepalive pings
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
