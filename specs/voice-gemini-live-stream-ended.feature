Feature: Gemini Live voice adapter surfaces a dead session instead of hanging
  As a developer running a Gemini Live voice scenario
  I want a terminated Live session to raise an attributable AgentStreamEndedError
  So that a dead transport surfaces its real cause instead of silently starving
  recv_audio until the caller's own response_timeout fires on audio that can
  never arrive

  # ROOT CAUSE (issue #718, verified in code on main @ 88aec40):
  # GeminiLiveAgentAdapter._session_lifetime opens the SDK session inside an
  # `async with client.aio.live.connect(...)` block, catches a failure into
  # self._session_error (gemini_live.py:247-248), and then RETURNS — which exits
  # the context manager and closes the session. recv_audio (:364) holds a cached
  # iterator obtained from that same session and NEVER consults _session_error,
  # so the call parks on `await self._recv_iter.__anext__()` (:411) against a
  # session nothing will ever feed.
  #
  # Three properties of that mechanism drive this spec, and each is a distinct
  # way a naive fix ships the bug anyway:
  #   1. recv_audio never reads _session_error at all.
  #   2. An ENTRY-ONLY check is insufficient. The production hang is a consumer
  #      ALREADY PARKED inside __anext__() when the session dies. A guard that
  #      only checks on function entry passes the obvious tests and still hangs.
  #      (Same lesson as #648: a sentinel test only discriminates if a consumer
  #      is already blocked when the stream ends.)
  #   3. _session_error is assigned ONLY inside `except Exception:`, so a task
  #      that is cancelled (CancelledError is a BaseException) or returns cleanly
  #      leaves it None while the hang persists. Task-done is the trigger;
  #      _session_error only supplies the cause when there is one.
  #
  # The scoping sweep that produced #718 named five adapters. Only gemini_live
  # has an unfixed gap; pipecat was fixed by #692 and twilio is already guarded.
  # openai_realtime, elevenlabs, websocket and composable read their transport
  # inline; livekit and vapi are transportless stubs; webrtc has the queue half
  # of the shape but nothing in-tree fills it. The remaining terminal-vs-transient
  # design calls are deferred to #868, #869, #870 and #871.

  Background:
    Given a GeminiLiveAgentAdapter connected against a duck-typed fake Live session
    And the fake session never imports the google-genai SDK and needs no credentials
    And every recv_audio call in this spec is wrapped in a 5 second guard so a
      blind hang fails the scenario instead of passing slowly

  # AC1 — the direct gap: a crashed session task is terminal and attributable.
  @integration @gemini-stream-ended
  Scenario: A session task that crashed surfaces an attributable stream-ended error
    Given the background session task has terminated by raising an exception
    When recv_audio is called
    Then it raises AgentStreamEndedError within the 5 second guard
    And the error's string representation names the GeminiLive transport
    And the error's __cause__ is the exact exception object the session task recorded
    And it does not return an empty AudioChunk, an asyncio.TimeoutError, or a bare RuntimeError

  # AC2 — a death with no exception is terminal too (the None-cause case).
  @integration @gemini-stream-ended
  Scenario: A session task that ended without an exception is still terminal
    Given the background session task is done and its exception is None
    When recv_audio is called
    Then it raises AgentStreamEndedError within the 5 second guard
    And the message names the task as ended without an error
    And a __cause__ of None is accepted rather than treated as a failure

  # AC3 — the discriminating case: an ALREADY-PARKED consumer must wake.
  @integration @gemini-stream-ended
  Scenario: A recv_audio already parked on the session iterator wakes when the session dies
    Given the fake session yields nothing so recv_audio suspends inside the iterator
    And the call is confirmed pending before anything else happens
    When the background session task is then killed
    Then the parked call raises AgentStreamEndedError within the 5 second guard
    And it does not wait out its own 30 second recv timeout
    And it does not raise asyncio.TimeoutError or return an empty AudioChunk

  # AC4 — the guard's window against the pre-existing reader and teardown.
  @integration @gemini-stream-ended
  Scenario: A pre-connect failure still surfaces through connect unchanged
    Given the session fails before connect returns
    When connect is awaited
    Then the original connect-time exception propagates unchanged
    And it is not swallowed, double-raised, or replaced by AgentStreamEndedError

  @integration @gemini-stream-ended
  Scenario: A recv_audio in flight when disconnect clears the error state still raises
    Given a recv_audio call is in flight against a dead session
    When disconnect resets the recorded session error to None
    Then the in-flight call still raises AgentStreamEndedError within the 5 second guard
    And it does not revert to hanging

  # AC5 — the bug is demonstrated behaviourally, not merely by code shape.
  @integration @gemini-stream-ended
  Scenario: The parked-consumer test fails by hanging against unmodified production code
    Given the production guard is absent
    When the already-parked scenario's test is run
    Then it fails by reaching its 5 second guard
    And this rules out the SDK already raising on context-manager exit, which would
      make the guard dead code

  # AC6 — the regression this change is most likely to introduce.
  @integration @gemini-stream-ended
  Scenario: A clean end of turn is not reclassified as a terminal error
    Given the fake session completes one model turn normally
    When the drain reads the turn to completion
    Then recv_audio returns an empty AudioChunk at the turn boundary
    And turn_complete continues to return an empty chunk
    And the recv span records a terminated_reason of terminal_chunk, not stream_ended
    And no pre-existing gemini test changes behaviour

  # AC7 — no regression on the already-correct adapters.
  @integration @gemini-stream-ended
  Scenario: The pipecat and twilio suites stay green with untouched assertions
    Given the pipecat recv-loop suite and the twilio silent-stop suite
    When they are run against this change
    Then every node passes
    And the change adds or removes no assertion line in either file

  # AC8 — the negative result is durable, recorded in code rather than in the issue.
  @unit @gemini-stream-ended
  Scenario: Each no-shape adapter records why it has no starvation surface
    Given the adapters that read their transport inline
    When each one's recv_audio definition is inspected
    Then openai_realtime, elevenlabs and websocket each carry the literal marker
      "no queue, no background reader (#718)"
    And webrtc carries a #718 marker stating its inbound queue is unfilled in-tree
      so a subclass that populates it reintroduces the shape
    And a bare substring search for "718" is rejected as insufficient, since it
      matches a sample rate, a byte count, or an unrelated number

  # AC9 — transportless stubs stay untouched.
  @unit @gemini-stream-ended
  Scenario: The transportless stub adapters are not modified
    Given livekit and vapi raise PendingTransportError unconditionally
    When the branch is diffed against origin/main
    Then neither file appears in the diff
    And the diff is taken against origin/main rather than the working tree, because a
      working-tree diff is empty on a committed branch regardless of what changed

  # AC10 — coverage is genuinely ungated, proven structurally.
  @unit @gemini-stream-ended
  Scenario: The new tests are creds-free by construction rather than by environment
    Given the voice conftest reloads the .env file at import time
    When the new test file is inspected and the voice suite is run
    Then no new test is skipped on a credential environment variable
    And each new test deletes those variables itself
    And every new node appears as passed and none appears in the skip report
    And clearing the variables in the process environment is rejected as proof,
      because the conftest silently restores them

  # AC11 — the shared drain contract both branches depend on.
  @integration @gemini-stream-ended
  Scenario: The base drain still distinguishes a first-chunk end from a tail end
    Given an adapter whose recv_audio raises AgentStreamEndedError
    When the error arrives on the first chunk
    Then the drain propagates it unchanged rather than relabelling it a first-chunk timeout
    When the error instead arrives on a tail chunk
    Then the drain ends the turn normally and returns the audio collected so far
    And the recv span records a terminated_reason of stream_ended for that exit path

  # AC12 — the cross-language half is out of scope but has a home.
  @unit @gemini-stream-ended
  Scenario: JavaScript parity is excluded from this change and tracked elsewhere
    Given the TypeScript SDK has no AgentStreamEndedError at all
    When the branch is diffed against origin/main
    Then no file under javascript/ appears in the diff
    And the TypeScript work is tracked by an open follow-up issue

  # --- AC Coverage Map ---
  # AC1  "crashed session task is attributable"        -> Scenario: A session task that crashed surfaces an attributable stream-ended error
  # AC2  "death without an exception is terminal"      -> Scenario: A session task that ended without an exception is still terminal
  # AC3  "already-parked consumer wakes"               -> Scenario: A recv_audio already parked on the session iterator wakes when the session dies
  # AC4  "window vs connect reader"                    -> Scenario: A pre-connect failure still surfaces through connect unchanged
  # AC4  "window vs disconnect reset"                  -> Scenario: A recv_audio in flight when disconnect clears the error state still raises
  # AC5  "bug demonstrated behaviourally (red-before)" -> Scenario: The parked-consumer test fails by hanging against unmodified production code
  # AC6  "clean turn not reclassified (regression)"    -> Scenario: A clean end of turn is not reclassified as a terminal error
  # AC7  "pipecat + twilio unaffected (regression)"    -> Scenario: The pipecat and twilio suites stay green with untouched assertions
  # AC8  "negative result recorded in code"            -> Scenario: Each no-shape adapter records why it has no starvation surface
  # AC9  "stub adapters untouched"                     -> Scenario: The transportless stub adapters are not modified
  # AC10 "ungated coverage proven structurally"        -> Scenario: The new tests are creds-free by construction rather than by environment
  # AC11 "base drain contract pinned"                  -> Scenario: The base drain still distinguishes a first-chunk end from a tail end
  # AC12 "JS parity out of scope, tracked"             -> Scenario: JavaScript parity is excluded from this change and tracked elsewhere
