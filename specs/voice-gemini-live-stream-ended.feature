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
  # TEARDOWN ORDER MATTERS. disconnect() runs aclose() (:278, inside an
  # `except Exception: pass`), then nulls _session_task (:298), then nulls
  # _session_error (:301). Because the guard triggers on task-done, :298 is the
  # line that actually strands it — not :301.
  #
  # NO Background section here on purpose: the connected-adapter precondition
  # would contradict the pre-connect-failure scenario, and would be inapplicable
  # to the static-check scenarios entirely. Preconditions are stated per scenario.
  #
  # ⚠ THE @integration TAGS BELOW ARE GHERKIN TAGS, NOT PYTEST MARKERS. Do NOT
  # transcribe them into @pytest.mark.integration on the test nodes. CI runs
  # `-m "not integration"` (.github/workflows/python-ci.yml:91), so a node marked
  # that way is DESELECTED in CI while every local run stays green — the test
  # would never execute on the gate it exists to satisfy. The auto-marker in
  # tests/voice/conftest.py keys on the `_e2e.py` filename only, so
  # test_gemini_live_stream_ended.py is not auto-gated; the only way to break
  # this is by hand. AC10 pins it.
  #
  # SCOPE. The sweep that produced #718 named five adapters; only gemini_live has
  # an unfixed gap. pipecat was fixed by #692, twilio is already guarded.
  # openai_realtime, elevenlabs and websocket read their transport inline.
  # composable has no transport at all (synchronous LLM+TTS) — a different
  # negative from the inline three, and marked with different wording.
  # livekit and vapi are transportless stubs; webrtc has the queue half of the
  # shape but nothing in-tree fills it. Remaining terminal-vs-transient design
  # calls are deferred to #868, #869, #870 and #871.

  # AC1 — the direct gap: a crashed session task is terminal and attributable.
  @integration @gemini-stream-ended
  Scenario: A session task that crashed surfaces an attributable stream-ended error
    Given a GeminiLiveAgentAdapter connected against a credential-free fake Live session
    And the background session task has terminated by raising an exception
    When recv_audio is called within a 5 second guard
    Then it raises AgentStreamEndedError
    And the error is the GeminiLive-specific subclass, not the base class
    And the error's string representation names the GeminiLive transport
    And the error's __cause__ is the exact exception object the session task recorded
    And it does not return an empty AudioChunk, an asyncio.TimeoutError, or a bare RuntimeError

  # AC2 — a death with no exception is terminal too (the None-cause case).
  @integration @gemini-stream-ended
  Scenario: A session task that ended without an exception is still terminal
    Given a GeminiLiveAgentAdapter connected against a credential-free fake Live session
    And the background session task is done and its exception is None
    When recv_audio is called within a 5 second guard
    Then it raises AgentStreamEndedError
    And the message names the task as ended without an error
    And a __cause__ of None is accepted rather than treated as a failure

  # AC3 — the discriminating case: an ALREADY-PARKED consumer must wake.
  # An entry-only guard passes AC1 and AC2 and still ships the production hang.
  @integration @gemini-stream-ended
  Scenario: A recv_audio already parked on the session iterator wakes when the session dies
    Given a GeminiLiveAgentAdapter connected against a credential-free fake Live session
    And the fake session yields nothing so recv_audio suspends inside the iterator
    And the call is confirmed pending before anything else happens
    When the background session task is then killed
    Then the parked call raises AgentStreamEndedError within a 5 second guard
    And it does not wait out its own 30 second recv timeout
    And it does not raise asyncio.TimeoutError or return an empty AudioChunk

  # AC4a — the pre-connect path stays owned by connect(), not by the new guard.
  @integration @gemini-stream-ended
  Scenario: A pre-connect failure still surfaces through connect unchanged
    Given a GeminiLiveAgentAdapter whose fake Live session fails before connect returns
    When connect is awaited
    Then the original connect-time exception propagates unchanged
    And it is not swallowed, double-raised, or replaced by AgentStreamEndedError

  # AC4b — all three teardown points, in the order disconnect() executes them.
  @integration @gemini-stream-ended
  Scenario: A recv_audio parked during disconnect raises at every teardown point
    Given a GeminiLiveAgentAdapter connected against a credential-free fake Live session
    And a recv_audio call is parked on the session iterator
    When disconnect closes the iterator, then nulls the session task, then nulls the session error
    Then the parked call raises AgentStreamEndedError within a 5 second guard at each of those three points
    And nulling the session task does not strand the guard that triggers on it
    And no point yields a RuntimeError, an AttributeError, a hang, or an empty AudioChunk

  # AC5 — the bug is demonstrated behaviourally, not merely by code shape.
  # Without this, nothing rules out the SDK already raising on context-manager
  # exit, which would make the entire guard dead code.
  @integration @gemini-stream-ended
  Scenario: The parked-consumer test fails by hanging against unmodified production code
    Given the production adapter files are restored to their origin/main contents
    And the new tests are kept in place
    When the whole new test file is run
    Then the parked-consumer scenario fails by reaching its 5 second guard
    And the expected red or green status of every other new node is stated and observed

  # AC6 — the regression this change is most likely to introduce.
  @integration @gemini-stream-ended
  Scenario: A clean end of turn is not reclassified as a terminal error
    Given a GeminiLiveAgentAdapter connected against a credential-free fake Live session
    And the fake session completes one model turn normally
    When the drain reads the turn to completion
    Then recv_audio returns an empty AudioChunk at the turn boundary
    And turn_complete continues to return an empty chunk
    And the recv span records a terminated_reason of terminal_chunk, not stream_ended
    And no pre-existing gemini test changes behaviour

  # AC7 — no regression on the already-correct adapters.
  # The count is pinned because an exit-0 on a skip-marked suite changes no
  # assert line, so the assert-diff check alone cannot catch a silent skip.
  @integration @gemini-stream-ended
  Scenario: The pipecat and twilio suites stay green with untouched assertions
    Given the pipecat recv-loop suite and the twilio silent-stop suite
    When they are run against this change
    Then the run reports seventeen passed with no skips
    And the change adds or removes no assertion line in either file

  # AC8 — the negative result is durable, recorded in code rather than in the issue.
  # A bare substring search for 718 is insufficient: it matches a sample rate, a
  # byte count, or 1718. The marker must sit between the def line and the
  # docstring, since the six lines after the def are all docstring body.
  @unit @gemini-stream-ended
  Scenario: Each no-shape adapter records why it has no starvation surface
    Given the adapters that have no dead-loop starvation surface
    When each one's recv_audio definition is inspected
    Then openai_realtime, elevenlabs and websocket each carry the inline-transport marker
    And webrtc carries a marker stating its inbound queue is unfilled in-tree
    And composable carries a distinct marker stating it has no transport at all
    And each marker is found within six lines of the recv_audio definition

  # AC9 — transportless stubs stay untouched.
  # The diff must be taken against origin/main; a working-tree diff is empty on a
  # committed branch regardless of what changed.
  @unit @gemini-stream-ended
  Scenario: The transportless stub adapters are not modified
    Given livekit and vapi raise PendingTransportError unconditionally
    When the branch is compared against origin/main and the working tree is checked
    Then neither file appears in the committed diff
    And neither file appears as uncommitted

  # AC10 — coverage is genuinely ungated, proven structurally.
  # Clearing the variables in the process environment is not proof: the voice
  # conftest reloads the .env file at import time and silently restores them.
  @unit @gemini-stream-ended
  Scenario: The new tests are creds-free by construction rather than by environment
    Given the voice conftest reloads the .env file at import time
    When the new test file is inspected and the voice suite is run
    Then the new file contains no skipif, importorskip, pytestmark or inline skip
    And each new test deletes the credential variables itself
    And every new node appears by name in the passed summary and none appears as skipped

  # AC11 — the shared drain contract both branches depend on.
  @integration @gemini-stream-ended
  Scenario: The base drain still distinguishes a first-chunk end from a tail end
    Given an adapter whose recv_audio raises AgentStreamEndedError
    When the error arrives on the first chunk
    Then the drain propagates it unchanged rather than relabelling it a first-chunk timeout
    And when the error instead arrives on a tail chunk the drain ends the turn normally
    And the recv span records a terminated_reason of stream_ended for that exit path

  # AC12 — the cross-language half is out of scope but has a home.
  @unit @gemini-stream-ended
  Scenario: JavaScript parity is excluded from this change and tracked elsewhere
    Given the TypeScript SDK has no AgentStreamEndedError at all
    When the branch is compared against origin/main and the working tree is checked
    Then no file under javascript is committed or uncommitted in this change
    And the TypeScript work is tracked by an open follow-up issue

  # AC13 — the error type and its export path carry their own obligation.
  # Without this, AC1 is satisfiable by raising the base class with a crafted
  # message, and the subclass-and-export deliverable has no gate at all.
  @unit @gemini-stream-ended
  Scenario: The GeminiLive error subclass is exported from both public modules
    Given the adapter defines a GeminiLive-specific recv error
    When it is imported from the voice package and from the adapters package
    Then both imports resolve to the same object
    And that object is a subclass of AgentStreamEndedError
    And it appears in the __all__ of both modules

  # --- AC Coverage Map ---
  # AC1  "crashed session task is attributable"        -> Scenario: A session task that crashed surfaces an attributable stream-ended error
  # AC2  "death without an exception is terminal"      -> Scenario: A session task that ended without an exception is still terminal
  # AC3  "already-parked consumer wakes"               -> Scenario: A recv_audio already parked on the session iterator wakes when the session dies
  # AC4  "window vs connect reader"                    -> Scenario: A pre-connect failure still surfaces through connect unchanged
  # AC4  "all three teardown points"                   -> Scenario: A recv_audio parked during disconnect raises at every teardown point
  # AC5  "bug demonstrated behaviourally (red-before)" -> Scenario: The parked-consumer test fails by hanging against unmodified production code
  # AC6  "clean turn not reclassified (regression)"    -> Scenario: A clean end of turn is not reclassified as a terminal error
  # AC7  "pipecat + twilio unaffected (regression)"    -> Scenario: The pipecat and twilio suites stay green with untouched assertions
  # AC8  "negative result recorded in code"            -> Scenario: Each no-shape adapter records why it has no starvation surface
  # AC9  "stub adapters untouched"                     -> Scenario: The transportless stub adapters are not modified
  # AC10 "ungated coverage proven structurally"        -> Scenario: The new tests are creds-free by construction rather than by environment
  # AC11 "base drain contract pinned"                  -> Scenario: The base drain still distinguishes a first-chunk end from a tail end
  # AC12 "JS parity out of scope, tracked"             -> Scenario: JavaScript parity is excluded from this change and tracked elsewhere
  # AC13 "error subclass exported both ways"           -> Scenario: The GeminiLive error subclass is exported from both public modules
