Feature: Voice user-simulator reacts to the agent's real transcript, not a fabrication
  As a developer running a hosted-ElevenLabs voice scenario over many turns
  I want the user-simulator to receive what the agent ACTUALLY said on every turn
  So that the simulator's next turn is grounded in the conversation and it does
  not fabricate replies about things the agent never said

  # ROOT CAUSE (issue #734, verified on main): drainAgentResponse closes the
  # agent turn on AUDIO silence (responseTailSilence) and never waits for the
  # transcript. Hosted ElevenLabs delivers the turn's text on a SEPARATE
  # agent_response socket event (sets lastAgentTranscript). When that event has
  # not landed by drain-close, attachAgentTurnTranscript snapshots a null
  # transcript, no {type:"text"} part is attached, and the turn reaches the
  # text-only simulator as a bare "[audio message]" -> the simulator fabricates.
  # The judge has an STT fallback (judge-stt); the simulator had none.

  Background:
    Given a hosted-ElevenLabs voice scenario whose agent audio always arrives
    And the agent's transcript is delivered on a separate agent_response event

  # AC1 — grace-wait (primary): wait for the transcript instead of racing it.
  @unit @ts-grace-wait
  Scenario: A transcript that lands after audio drain but within the grace window is attached
    Given an agent turn whose audio drains before the transcript event lands
    And the transcript event lands within the adapter's transcriptGraceWait ceiling
    When defaultVoiceCall drains the agent response
    Then it awaits lastAgentTranscript up to the bounded ceiling before reading it
    And the arriving transcript is attached as a {type:"text"} part on the turn

  # AC3 — no-regression: zero added latency when the transcript won the race.
  @unit @ts-grace-wait
  Scenario: The grace-wait short-circuits when the transcript is already present
    Given an agent turn whose transcript is already set at drain-close
    When defaultVoiceCall reaches the grace-wait
    Then it returns immediately without spending the transcriptGraceWait ceiling
    And the transcript is still attached to the turn

  # AC1 (bounded) — a genuine ElevenLabs drop still terminates the turn.
  @unit @ts-grace-wait
  Scenario: A transcript that never arrives terminates the turn after the ceiling
    Given an agent turn whose transcript event never lands
    When defaultVoiceCall reaches the grace-wait
    Then it elapses the bounded ceiling and returns an audio-only turn
    And the call does not hang

  # AC2 — STT fallback (safety net): cover the case EL never sends agent_response.
  @unit @ts-sim-stt
  Scenario: The simulator transcribes an audio-only agent turn before stripping audio
    Given an agent turn that reaches the user-simulator as audio with no transcript
    And a per-run STT provider resolved off scenarioConfig.voice
    When the user-simulator prepares its LLM input
    Then it transcribes the audio via the shared STT helper before stripAudioContent
    And the simulator's LLM input carries the real transcript, not "[audio message]"

  # AC2 — the STT plumbing is shared with the judge, not duplicated.
  @unit @ts-sim-stt
  Scenario: The simulator reuses the judge's STT pre-pass helper
    Given the judge's prepareJudgeInput and the simulator both need audio transcribed
    When either path runs its STT pre-pass
    Then both delegate to the single shared transcribeAudioMessages helper

  # AC4 — observability: per-turn transcript-lag-vs-audio-drain is measurable.
  @integration @ts-grace-wait
  Scenario: The ElevenLabs adapter logs transcript lag behind audio drain
    Given a forced-race run (responseTailSilence shrunk so the transcript loses)
    When the agent_response transcript event fires
    Then the adapter debug-logs the transcript lag against the last agent-audio frame
    And a lag exceeding responseTailSilence is flagged as a pre-fix lost race

# --- AC Coverage Map ---
# AC1 (grace-wait): javascript/src/voice/adapter.runtime.ts awaitAgentTranscript,
#   javascript/src/voice/adapter.ts transcriptGraceWait field
#   -> src/voice/__tests__/transcript-grace-wait.test.ts (AC5 delayed-transcript,
#      short-circuit, bounded)
# AC2 (STT fallback): javascript/src/agents/user-simulator-agent.ts +
#   shared transcribeAudioMessages in javascript/src/voice/judge-stt.ts
#   -> src/agents/__tests__/user-simulator-stt-fallback.test.ts
# AC3 (no-regression): short-circuit timing test in transcript-grace-wait.test.ts;
#   existing voice tests stay green; OpenAI-realtime path untouched.
# AC4 (observability): javascript/src/voice/adapters/elevenlabs.ts callbackAgentResponse
#   debug log (transcriptLagMs / lostRacePreFix).
# AC5 (falsifiability): the AC1 delayed-transcript test fails on main, passes with the fix.
