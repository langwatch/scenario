Feature: Voice E2E against hosted ElevenLabs — real voice-in, multi-turn, per-call personalisation, and agent hangup
  As a developer testing a deployed ElevenLabs Conversational AI agent
  I want the harness to speak to it the way a real caller does and to end the run the way a real call ends
  So that a green scenario is evidence about the agent's own STT, turn-taking, and hangup behaviour
  And so the docs describe what the adapter actually does

  Background:
    Given the hosted ElevenLabs ConvAI transport is server-VAD-driven, so it closes a turn on an audio→silence transition
    And the adapter streams the user's real PCM as 20 ms frames at microphone cadence, then UNBOUNDED closing silence, which supplies that transition
    And a bounded silence tail does NOT reliably close a scripted turn — EL ConvAI 2.0 uses a hybrid VAD plus a deep-learning turn-detector, not a pure silence threshold
    And the TypeScript and Python adapters are at behavioural parity on this path

  # ============================================================
  # Group: Real voice-in — the agent actually hears the user
  # ============================================================

  @unit
  Scenario: A scripted user turn goes on the wire as real audio, not injected text
    Given a connected hosted ElevenLabs adapter in its default turn-commit mode
    When a scripted user turn carrying both PCM and a transcript is sent
    Then the frames on the wire are `user_audio_chunk` carrying that PCM
    And NO `user_message` text commit is sent
    And the adapter's real-audio turn counter increments once for the turn, not once per frame

  @unit
  Scenario: The default path appends no bounded silence tail
    Given a connected hosted ElevenLabs adapter in its default turn-commit mode
    When a scripted user turn is sent and the pump drains it
    Then only the speech frames were queued behind it
    And ticking the pump on an empty queue yields closing silence indefinitely
    And that unbounded closing silence — not a fixed tail — is what ends the turn

  @unit
  Scenario: An empty chunk is not a turn
    Given a connected hosted ElevenLabs adapter
    When a chunk carrying no PCM is sent
    Then no frame is queued and the real-audio turn counter does not move

  @unit
  Scenario: Text turn-commit remains available as an explicit opt-in
    Given a hosted ElevenLabs adapter constructed with the text turn-commit mode
    When a scripted user turn carrying a transcript is sent
    Then a `user_message` commit carrying exactly `type` and `text` is sent
    And NO `user_audio_chunk` is sent, so the agent's STT never runs on that turn

  @e2e @ts-elevenlabs
  Scenario: ElevenLabs transcribes the streamed audio on every scripted turn
    Given `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, and `OPENAI_API_KEY` are set
    When a greeting-led multi-turn scenario runs against the live hosted agent
    Then EL emits a non-empty `user_transcript` for EACH scripted user turn
    And those transcripts are EL's own transcription of our PCM, not an echo of the script text
    And the real-audio turn counter is at least the number of scripted user turns

  # ============================================================
  # Group: Multi-turn
  # ============================================================

  @unit
  Scenario: A scripted second user turn re-engages a second agent response
    Given a connected hosted ElevenLabs adapter and a drained greeting
    When a first user turn is sent and the agent responds
    And a second user turn is sent
    Then a second agent response resolves rather than timing out

  @e2e @ts-elevenlabs
  Scenario: Multi-turn passes live on the hosted transport
    Given `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, and `OPENAI_API_KEY` are set
    When the greeting-led `agent()→user→agent→user→agent→judge` script runs live
    Then the run passes and the summary shows it PASSED, not skipped
    And `proceed(n)` drives the same transport without a per-adapter caveat

  # ============================================================
  # Group: Per-call personalisation (issue #838)
  # ============================================================

  @unit
  Scenario: Dynamic variables are forwarded natively on the init handshake
    Given a hosted ElevenLabs adapter constructed with text, numeric, and boolean dynamic variables
    When the adapter connects
    Then the init frame carries `dynamic_variables` with each value's JSON type preserved
    And no value is coerced to a string

  @unit
  Scenario: The dynamic-variables key is absent when unset
    Given a hosted ElevenLabs adapter constructed with no dynamic variables
    When the adapter connects
    Then the init frame carries NO `dynamic_variables` key, because EL distinguishes absent from empty

  @unit
  Scenario: Caller overrides deep-merge under the narrow prompt knobs
    Given a hosted ElevenLabs adapter constructed with a system-prompt override and an `agent.language` override
    When the adapter connects
    Then the init frame's `conversation_config_override` carries BOTH `agent.language` and `agent.prompt`
    And a sibling top-level key such as `tts` survives the merge intact
    And on a shared leaf the narrow prompt knob wins over the caller's override

  @e2e @ts-elevenlabs
  Scenario: A per-call dynamic variable and language override land on the live agent
    Given a live hosted agent whose prompt template references a dynamic variable
    And the agent allowlists `agent.language` in its platform override settings
    When a session supplies that variable and an `agent.language` override
    Then the agent's reply contains the supplied value
    And the reply is in the overridden language, proving both survived one handshake

  @integration
  Scenario: Overriding the system prompt is documented as dropping the agent's tools
    Given the ElevenLabs adapter reference page
    When a reader looks up the system-prompt override
    Then the page warns that it replaces the ENTIRE prompt object including `tool_ids`
    And it routes per-call personalisation to dynamic variables plus a narrow override instead

  # ============================================================
  # Group: Agent-initiated hangup (issue #839)
  # ============================================================

  @unit
  Scenario: A successful end_call marks the call as ended by the agent
    Given a connected hosted ElevenLabs adapter
    When EL emits an `agent_tool_response` for `end_call` with `is_called` true and no error or block
    Then the adapter records that the agent hung up

  @unit
  Scenario Outline: A transfer tool also ends this session
    Given a connected hosted ElevenLabs adapter
    When EL emits a successful `agent_tool_response` for <tool>
    Then the adapter records that the agent hung up

    Examples:
      | tool                 |
      | transfer_to_agent    |
      | transfer_to_number   |
      | transfer_to_genesys  |

  @unit
  Scenario Outline: An unsuccessful hangup tool is not a hangup
    Given a connected hosted ElevenLabs adapter
    When EL emits an `agent_tool_response` for `end_call` that was <outcome>
    Then the adapter does NOT record a hangup, so a later close still surfaces as a transport failure

    Examples:
      | outcome     |
      | not called  |
      | errored     |
      | blocked     |

  @unit
  Scenario: A scripted turn after a deliberate hangup concludes instead of failing
    Given a hosted ElevenLabs agent that said its farewell and invoked `end_call`
    And EL closed the socket cleanly afterwards
    When the script still has an `agent()` step left
    Then that step concludes the conversation and adds no messages
    And the script falls through to the judge rather than raising a transport error

  @unit
  Scenario: A dropped transport with no hangup still raises
    Given a connected hosted ElevenLabs adapter whose transport dropped with no hangup tool invoked
    When a scripted `agent()` step runs
    Then it raises the transport-not-connected error, so genuine failures are not masked

  @e2e @ts-elevenlabs
  Scenario: A live agent hangup ends the run cleanly
    Given a live hosted agent instructed to say goodbye and invoke `end_call`
    When the scripted scenario still has a turn left after the farewell
    Then the adapter reports that the agent hung up
    And the remaining turn concludes without raising

  # ============================================================
  # Group: Docs reflect the shipped behaviour
  # ============================================================

  @integration
  Scenario: The multi-turn recipe no longer excludes the hosted adapter
    Given recipes/multi-turn.mdx
    When the docs-honesty grep gate runs in CI
    Then `grep -niF 'not supported on hosted' docs/docs/pages/voice/recipes/multi-turn.mdx` returns NOTHING
    And the page states multi-turn works on hosted `elevenLabsAgent`

  @integration
  Scenario: The troubleshooting entry diagnoses the real causes
    Given troubleshooting.mdx
    When the troubleshooting grep gate runs in CI
    Then the `receiveAudio timed out` entry no longer claims a single-exchange ceiling
    And it lists the greeting-drain rule, the turn-commit mode, a deliberate hangup, and a wedged tool call as the causes to check
    And the "duration mismatch / non-continuous audio input" entry is still documented as a benign server-side warning

  @integration
  Scenario: The happy-path doc leads with agent() and carries both SDKs
    Given happy-path-elevenlabs.mdx
    When the docs gate runs in CI
    Then `scenario.agent()` precedes the first scripted `user(` so the greeting drains first
    And every code step is shown for BOTH Python and TypeScript

  @integration
  Scenario: The capability matrix and adapter page agree with the code
    Given the generated capability matrix and the ElevenLabs adapter page
    When the matrix regeneration gate runs in CI
    Then the committed matrix matches what the adapters declare
    And the adapter page documents dynamic variables, overrides, turn-commit modes, and the hangup flag
