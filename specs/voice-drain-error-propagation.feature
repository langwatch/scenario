Feature: The voice drain ends a turn on silence, not on failure
  As a developer running a voice scenario
  I want a dead transport or a broken adapter to fail my run loudly
  So that a scenario never passes on a turn the agent never took

  # ROOT CAUSE (issue #756, verified on main): drainAgentResponse wrapped its
  # tail-silence probe in a bare `catch { break }`. That cannot tell "no audio
  # within responseTailSilence" — how every turn ends — from a hard error, so
  # both closed the turn. In #697 the Twilio adapter threw "no live media
  # stream" on the drain's follow-up call after the media-stream transport was
  # torn down; Python surfaced it immediately (its drain catches only
  # asyncio.TimeoutError) while TypeScript swallowed it and merely TRUNCATED
  # the turn. The defect stayed invisible through CI, five rounds of automated
  # review, and the original human reproduction. A swallowed hard error
  # degrades a loud crash into silent data loss, which for a test framework is
  # the worse failure: the scenario keeps running and asserts against a turn
  # that never happened.

  Background:
    Given a voice adapter whose receiveAudio the drain calls to collect a turn

  # AC1 — the fix: hard errors reach the caller.
  @unit @ts-voice-drain
  Scenario: A hard error from the tail-silence receive fails the turn
    Given the agent has already sent one audio chunk
    And the next receiveAudio rejects with a transport failure
    When defaultVoiceCall drains the agent response
    Then call() rejects with that same error object, unwrapped
    And no agent messages are produced for the truncated turn
    And the voice.audio.receive span is ERROR and is not labelled tail_silence

  # AC2 — no regression: silence is still how a turn ends.
  @unit @ts-voice-drain
  Scenario: A receive deadline closes the turn and keeps the audio collected
    Given the agent has already sent two audio chunks
    And the next receiveAudio rejects with a receive timeout
    When defaultVoiceCall drains the agent response
    Then the turn completes successfully with both chunks
    And the voice.audio.receive span is labelled tail_silence

  # AC3 — the contract a custom adapter has to meet, with no import from us.
  @unit @ts-voice-drain
  Scenario Outline: Any error named TimeoutError is read as a receive deadline
    Given the agent has already sent one audio chunk
    And the next receiveAudio rejects with <rejection>
    When defaultVoiceCall drains the agent response
    Then the turn completes successfully
    And the voice.audio.receive span is labelled tail_silence

    Examples:
      | rejection                                     |
      | the shared ReceiveTimeoutError                |
      | a custom Error whose name is TimeoutError     |
      | the DOMException AbortSignal.timeout() raises |

  # AC4 — every built-in adapter has to hold up its half of AC3, or a normal
  # end of turn crashes the run.
  @unit @ts-voice-drain
  Scenario: A built-in adapter's own deadline is classified as a receive timeout
    Given a built-in adapter connected to a transport that stays open and silent
    When its receiveAudio deadline expires
    Then the rejection is classified as a receive timeout
    And the rejection still carries a diagnosis the developer can read

  # AC5 — the same distinction on the sibling call, matching Python's drain,
  # which labels only asyncio.TimeoutError there.
  @unit @ts-voice-drain
  Scenario: A hard error before the first chunk is not attributed to a timeout
    Given the first receiveAudio of the turn rejects with a transport failure
    When defaultVoiceCall drains the agent response
    Then the voice.audio.receive span is ERROR with no terminated_reason
    And the span does not claim first_chunk_timeout

  # AC6 — #839/#849: an agent that hangs up wakes the parked receive with the
  # empty end-of-stream chunk, so narrowing the catch must not punish it.
  @unit @ts-voice-drain
  Scenario: A deliberate agent hangup remains a clean end of turn
    Given the agent has already sent one audio chunk
    And the agent hung up, so the next receiveAudio returns an empty chunk
    When defaultVoiceCall drains the agent response
    Then the turn completes successfully with agentHungUp still set
    And the voice.audio.receive span is labelled terminal_chunk

  # AC7 — the rule is per DRAIN LOOP, not per adapter. The user-simulator side
  # has its own, and #623 will add more as agent-initiated turns spread to the
  # other adapters. Each one has to make the same distinction.
  @unit @ts-voice-drain
  Scenario: The spoken user-turn drain fails on a server error
    Given the simulator is speaking a scripted user line
    And a server error arrives after the first audio delta
    When the spoken turn drains
    Then the error reaches the caller
    And no partial spoken line is returned as the user's turn
