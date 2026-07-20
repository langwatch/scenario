Feature: ElevenLabs voice adapter reconciles its audioQueue at turn boundaries
  As a developer running a hosted-ElevenLabs voice scenario over many turns
  I want one agent utterance to land as exactly one agent message — all of its
  audio and its matching transcript in a single history entry
  So that a split utterance never bleeds its remainder into a fake next turn and
  the judge does not fail the run for "the assistant repeated its greeting"

  # ROOT CAUSE (issue #747, verified in code + live repro at javascript/v0.5.1):
  # the EL adapter's audioQueue (elevenlabs.ts:340) is only ever pushed (:554)
  # and shifted (:778) — never reconciled at a turn boundary. When an utterance
  # is split — capped by responseMaxDuration=30s (drainAgentResponse's
  # `while (accumulated < maxDuration)` exits mid-utterance) or by an inter-chunk
  # delivery gap > responseTailSilence=0.6s — the remainder stays queued and the
  # NEXT agent() drain shifts it out instantly (gap=0ms) as the start of a fake
  # agent turn. From there transcripts attach to the wrong audio, some turns get
  # transcript with 0s audio, others audio with no transcript, and the judge
  # reads the doubled greeting text and fails the run.
  #
  # EL emits NO end-of-turn signal (server events: agent_response / audio /
  # interruption / user_transcript / client_tool_call / ping /
  # conversation_initiation_metadata) — agent_response is the sole turn-identity
  # marker, so reconciliation is epoch-stamped on it.

  Background:
    Given a hosted-ElevenLabs voice scenario driven by a `[agent(), proceed(...)]` script
    And the agent's audio arrives as raw PCM frames buffered on the adapter's audioQueue
    And the agent's transcript arrives on a separate agent_response event

  # AC1 — split greeting lands as ONE message (primary, live).
  @e2e @el-audioqueue
  Scenario: A greeting whose TTS exceeds responseMaxDuration is one assistant message
    Given a firstMessageOverride greeting whose TTS runs longer than responseMaxDuration
    And the run reproduces the split trigger (the greeting message's audio-seconds >= responseMaxDuration + 5)
    When the fixed build runs the scenario at least twice
    Then the greeting is exactly one assistant history message whose whisper transcript contains the greeting's final sentence
    And no later assistant message contains greeting audio or repeats the greeting text
    And the run's judge verdict is PASS

  # AC2 — no fake instant turn / no stale bleed (live).
  @e2e @el-audioqueue
  Scenario: Every assistant message's audio matches its own transcript with no cross-turn bleed
    Given the fixed build has run the split-greeting scenario at least twice
    When each assistant message's own audio is transcribed with whisper
    Then every assistant message's audio matches its own transcript field at token Jaccard >= 0.7
    And no assistant message's audio transcribes to the last 8-or-more trailing words of the previous assistant message's text

  # AC3 — boundary reconciliation is attributed, not silent (deterministic).
  @integration @el-audioqueue
  Scenario: Stale queued audio at a turn boundary is attributed to the prior utterance, not emitted as a new turn
    Given agent audio is still queued from the prior utterance when the next user turn is committed
    When the runtime reconciles the turn boundary
    Then the next assistant message contains none of that stale audio
    And the stale audio is preserved in the recording, growing the prior agent segment by exactly the stale bytes
    And a warning naming the reconciliation and its reconciled duration is logged

  # AC3(d) — gap-split never becomes a fake turn (re-scoped: an already-broadcast
  # message is immutable, so a LATE burst cannot be merged into it — but it is
  # never emitted as a new turn and is preserved in the recording).
  @integration @el-audioqueue
  Scenario: A gap-split utterance's continuation is merged when available and never a fake turn when late
    Given a fake adapter delivers ONE utterance as two bursts with a single agent_response spanning both
    And no user turn occurs between the two bursts
    When both bursts are immediately available at drain time
    Then the un-chopped drain consumes both into one assistant message
    When instead the second burst arrives after the turn already closed
    Then the second burst is never emitted as a new agent turn
    And it is preserved in the recording attributed to the utterance that produced it

  # AC4 — responseMaxDuration no longer silently truncates.
  @unit @el-audioqueue
  Scenario: A continuous utterance longer than responseMaxDuration lands whole
    Given a fake adapter delivers continuous audio chunks totalling more than responseMaxDuration with no inter-chunk gap
    When defaultVoiceCall drains the agent response
    Then the merged turn contains the entire utterance's audio
    And a responseMaxDuration-exceeded warning is logged

  # AC4(b) — a non-terminating stream is bounded and warned, never silently capped or wedged.
  @unit @el-audioqueue
  Scenario: A never-silent audio stream terminates the drain at a bounded ceiling with a warning
    Given a fake adapter whose audio never goes silent
    When defaultVoiceCall drains the agent response
    Then the drain terminates once accumulated audio reaches at most 2x responseMaxDuration
    And an explicit warning is logged
    And the call does not hang

  # AC5 — transcript<->audio pairing (live + regression).
  @e2e @el-audioqueue
  Scenario: No two assistant messages share one utterance's transcript and every transcript pairs with its own audio
    Given the fixed build has run the split-greeting scenario at least twice
    When the assistant messages are inspected
    Then no two assistant messages carry the same EL agent_response text for one utterance
    And no assistant message carries a transcript whose audio lives in a different message
    And a turn whose transcript event never arrives still falls back to an audio-only message with a manifest STT back-fill and no new fabrication

  # AC6 — clean runs unchanged (regression, live).
  @e2e @el-audioqueue
  Scenario: A standard multi-turn run with sub-cap utterances is unchanged and adds no latency
    Given a standard hosted-EL multi-turn run with every utterance under responseMaxDuration and stock defaults
    When the fixed build runs the scenario
    Then each exchange is one user message and one assistant message and the judge passes
    And the run is coherent by the AGENTS_HEARD_EACH_OTHER criterion, not by message counts
    And the median per-turn agent-response wall-clock is within 250 ms of a pre-fix control median over at least 6 exchanges
    And no single turn exceeds the control-max by more than 500 ms

  # AC7 — shared-runtime consumers unaffected (regression).
  @integration @el-audioqueue
  Scenario: The shared drain change leaves every other voice adapter untouched
    Given adapters that do not expose the reconcilePendingAudio convention (OpenAI Realtime, Gemini, Twilio, Pipecat, composable)
    When the full JS voice test suite runs
    Then those adapters' tests pass unchanged including interruption, tool-call terminal turn, #734 grace-wait, and #705 pump-pause
    And the assertion-count under javascript/src/voice/**/__tests__/** is non-decreasing versus the merge base

  # AC8 — greeting flow preserved (regression).
  @unit @el-audioqueue
  Scenario: The agent-first greeting is still delivered as turn one and never reconciled away
    Given the on-connect greeting audio is buffered on the adapter's audioQueue before any call
    And the first agent() turn has no incoming user audio
    When defaultVoiceCall drains that first turn
    Then it returns the buffered greeting as turn one
    And the boundary reconciliation does not swallow or reattribute the greeting

  # AC9 — barge-in safety (failure mode, re-scoped): no fake turn + cursor stays
  # monotonic. Backward-attribution is NOT done on the barge-in path (the user
  # segment is already laid after the interrupted agent segment on the cursor).
  @integration @el-audioqueue
  Scenario: A mid-drain barge-in leaves no fake turn and a monotonic recording cursor
    Given a non-blocking agent turn is in flight and the user barges in with audio mid-drain
    When the interrupt fires and delivers the user audio
    Then leftover post-interrupt agent audio is never emitted as the next agent turn
    And the recording cursor stays monotonic with no overlapping segments
    And the boundary reconcile does not run on the barge-in path

  # AC10 — documented workaround stays valid (compat).
  @unit @el-audioqueue
  Scenario: A responseTailSilence of 2.0 composes with the fix
    Given responseTailSilence is set to 2.0 (the documented interim workaround)
    When defaultVoiceCall drains an agent response
    Then the drain behaves per the clean-run guarantee with no double-waiting
    And no drain semantics change beyond the longer tail window

  # --- AC Coverage Map ---
  # AC1  "split greeting lands as one message"                 -> Scenario: A greeting whose TTS exceeds responseMaxDuration is one assistant message
  # AC2  "no fake instant turn / no stale bleed"               -> Scenario: Every assistant message's audio matches its own transcript with no cross-turn bleed
  # AC3  "reconciliation attributed, not silent"               -> Scenario: Stale queued audio at a turn boundary is attributed to the prior utterance, not emitted as a new turn
  # AC3d "gap-split: merged when available, no fake turn when late" -> Scenario: A gap-split utterance's continuation is merged when available and never a fake turn when late
  # AC4a "responseMaxDuration no longer truncates"             -> Scenario: A continuous utterance longer than responseMaxDuration lands whole
  # AC4b "non-terminating stream bounded + warned"             -> Scenario: A never-silent audio stream terminates the drain at a bounded ceiling with a warning
  # AC5  "transcript<->audio pairing"                          -> Scenario: No two assistant messages share one utterance's transcript and every transcript pairs with its own audio
  # AC6  "clean runs unchanged (regression)"                   -> Scenario: A standard multi-turn run with sub-cap utterances is unchanged and adds no latency
  # AC7  "shared-runtime consumers unaffected (regression)"    -> Scenario: The shared drain change leaves every other voice adapter untouched
  # AC8  "greeting flow preserved (regression)"                -> Scenario: The agent-first greeting is still delivered as turn one and never reconciled away
  # AC9  "barge-in safety (failure mode)"                      -> Scenario: A mid-drain barge-in leaves no fake turn and a monotonic recording cursor
  # AC10 "workaround stays valid (compat)"                     -> Scenario: A responseTailSilence of 2.0 composes with the fix
