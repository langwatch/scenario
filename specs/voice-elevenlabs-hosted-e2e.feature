Feature: Voice E2E against hosted ElevenLabs — single-exchange ceiling, multi-turn routing, and reconciled docs
  As a developer porting chatbox scenarios to voice against a hosted ElevenLabs ConvAI agent
  I want the docs to teach the real hosted single-exchange ceiling and route multi-turn to the adapters that support it
  So that I stop hitting `receiveAudio timed out` on patterns the docs implied were universal
  And so the SDK fails informatively instead of with a bare timeout

  Background:
    Given the hosted ElevenLabs ConvAI transport is server-VAD-driven, so its ceiling is ONE greeting-led user↔agent exchange
    And the adapter send-path is verified correct — user audio reaches ElevenLabs on the 2nd scripted turn (adapter.runtime.ts:261-266), the timeout is the server VAD not re-engaging, not a missing-audio bug
    And the SILENCE_TAIL_BYTES end-of-turn pad (elevenlabs.ts:241-254) is the maintainers' acknowledged best-effort for hosted turn-taking
    And multi-turn voice is supported only on the composable ElevenLabsVoiceAgent, pipecatAgent, Gemini Live, and OpenAI Realtime adapters

  # ============================================================
  # Group: Reporter deliverable
  # ============================================================

  @e2e
  Scenario: The resolving comment answers the reporter's three questions, each tied to a docs anchor
    Given a developer reading the issue's resolving comment
    When they look for the answers to the three reporter questions
    Then the comment states the correct hosted script is the greeting-led single exchange `agent()→user→agent→judge`, anchored to happy-path-elevenlabs.mdx (AC4a)
    And the comment states `proceed()` is NOT reliable on hosted `elevenLabsAgent` and works on composable/pipecat/realtime, anchored to recipes/multi-turn.mdx (AC11)
    And the comment states 5–45-turn flows are unsupported on hosted ConvAI and route to `ElevenLabsVoiceAgent`/`pipecatAgent`, anchored to recipes/multi-turn.mdx (AC1, AC11)
    And each of the three answers carries a clickable docs URL, not a bare claim

  # ============================================================
  # Group: Docs reconciliation — hosted ceiling and multi-turn routing
  # ============================================================

  @e2e
  Scenario: A reader of the multi-turn recipe learns the hosted ceiling and is routed to a working adapter
    Given a developer opening docs/voice/recipes/multi-turn on the published site
    When they read the page that teaches the `agent→user→agent→…→judge` pattern
    Then the page states the multi-turn pattern is NOT supported on hosted `elevenLabsAgent`
    And the page affirmatively routes multi-turn AND `proceed(n)` to the composable `ElevenLabsVoiceAgent`, `pipecatAgent`, Gemini Live, and OpenAI Realtime adapters
    And the "worked example" link resolves to a multi-turn test using a composable/pipecat adapter, NOT `elevenLabsAgent`

  @integration
  Scenario: The multi-turn recipe carries the hosted-NOT-supported caveat as a grep-gated invariant
    Given recipes/multi-turn.mdx after the reconciliation pass
    When the docs-honesty grep gate runs in CI
    Then `grep -nF 'not supported on hosted' docs/docs/pages/voice/recipes/multi-turn.mdx` returns a line
    And `grep -nF 'elevenLabsAgent' docs/docs/pages/voice/recipes/multi-turn.mdx` returns the caveat line
    And both tokens are ABSENT on the unmodified tree, so the gate goes red until the caveat lands (AC1)

  @integration
  Scenario: The multi-turn recipe's positive-routing line is grep-gated to a composable adapter
    Given recipes/multi-turn.mdx after the reconciliation pass
    When the positive-routing grep gate runs in CI
    Then `grep -nF 'ElevenLabsVoiceAgent' docs/docs/pages/voice/recipes/multi-turn.mdx` returns the routing line
    And the worked-example link target resolves to a composable/pipecat multi-turn test, never `elevenLabsAgent` (AC11)

  @integration
  Scenario: The getting-started page caveats proceed() against hosted ConvAI next to each occurrence
    Given docs/docs/pages/voice/getting-started.mdx which presents `proceed(n)` at lines 117 and 179
    When `grep -nA3 'scenario.proceed' docs/docs/pages/voice/getting-started.mdx` runs in CI
    Then a hosted-ConvAI caveat appears within 3 lines of EACH `proceed(` occurrence
    And the page no longer presents `proceed(n)` as a universal voice driver (AC2)

  # ============================================================
  # Group: Docs reconciliation — troubleshooting
  # ============================================================

  @e2e
  Scenario: A developer hitting the hosted timeout finds the diagnosis and the greeting-drain fix
    Given a developer who hit `receiveAudio timed out` on hosted ElevenLabs
    When they open docs/voice/troubleshooting on the published site
    Then the page has a `receiveAudio timed out` entry naming the server-VAD single-exchange ceiling
    And the entry states the "lead with `agent()` to drain the greeting" rule
    And the entry documents the "Audio duration mismatch / non-continuous audio input" message as a benign server-side ConvAI warning, not an SDK error

  @integration
  Scenario: The troubleshooting timeout and duration-warning entries are grep-gated
    Given troubleshooting.mdx after the reconciliation pass
    When the troubleshooting grep gate runs in CI
    Then `grep -nF 'receiveAudio timed out' docs/docs/pages/voice/troubleshooting.mdx` returns the entry (AC3)
    And `grep -niE 'duration mismatch|non-continuous' docs/docs/pages/voice/troubleshooting.mdx` returns the benign-warning entry (AC5)
    And both strings are ABSENT on the unmodified tree, so the gate goes red until the entries land

  # ============================================================
  # Group: Docs reconciliation — happy-path doc and example parity
  # ============================================================

  @e2e
  Scenario: The happy-path doc teaches the greeting-led single exchange
    Given a developer opening happy-path-elevenlabs.mdx on the published site
    When they read the canonical hosted script block (currently user-first at lines 76-79)
    Then the script leads with `scenario.agent()` to drain the on-connect greeting before the first `scenario.user(`
    And the taught shape is `agent()→user→agent→judge`, the documented single-exchange ceiling

  @integration
  Scenario: The happy-path script is grep-gated to greeting-led order
    Given happy-path-elevenlabs.mdx after the reconciliation pass
    When `grep -nB1 'scenario.user(' docs/docs/pages/voice/happy-path-elevenlabs.mdx` runs in CI
    Then `scenario.agent()` immediately precedes the first `scenario.user(` in the script block (AC4a)

  @integration
  Scenario: The python and TS hosted examples share one greeting-led script with no self-contradicting docstring
    Given the python and TS hosted ElevenLabs example files
    When the example-parity grep gate runs in CI
    Then `grep -rnE 'scenario\.(agent|user|judge)' <python-hosted-example> <ts-hosted-example>` shows the identical ordered step sequence in both
    And `grep -niE 'single.?turn' <python-hosted-example>` returns no "single-turn" docstring/comment sitting above a 2nd scripted `user()` turn (AC4b)

  # ============================================================
  # Group: Behavior / failure-mode (SDK boundary condition)
  # ============================================================

  @integration
  Scenario: A 2nd scripted user turn on hosted elevenLabsAgent fails informatively, not with a bare timeout
    Given a hosted `elevenLabsAgent` script with a 2nd scripted `user()` turn after the greeting exchange
    When the 2nd `agent()` turn hits the server-VAD re-engagement failure
    Then the emitted error/warning string contains "hosted ConvAI" AND one of "single exchange"/"single-turn ceiling"
    And the message points to the troubleshooting anchor, not just the bare `receiveAudio timed out`
    And the test log line quoting the emitted message is the evidence — OR a linked decision record accepts the bare timeout plus the AC3 troubleshooting entry as the contract, citing the troubleshooting URL (AC6)

  @integration
  Scenario: A voice agent-under-test receiving a text user turn gets a louder warning than silent passthrough
    Given a no-voice-resolves path where `voiceify` falls through and a voice agent-under-test receives a TEXT user turn
    When the turn is dispatched to the agent
    Then the SDK emits a louder warning than silent text passthrough, and a test exercising the no-voice-resolves path quotes it
    And the OR-branch is visible: if the reporter's posted `scenario.run({...})` config shows `voice:'openai/nova'` resolves with no pre-built ModelMessage user turns, AC7 is struck with that quoted config as the rationale (AC7)

  # ============================================================
  # Group: Regression + proven-path tests (gated live pass + ungated CI shape)
  # ============================================================

  @unit
  Scenario: The hosted single-exchange shape is provable in keyless CI without a paid endpoint
    Given the env-gated hosted suite skip-passes in keyless CI (describe.skip at line 224, hasHostedKey gate at lines 36-39), so a keyless green is VACUOUS
    When the ungated shape assertion runs in keyless CI
    Then `grep -nF 'scenario.agent(),' elevenlabs-hosted.test.ts` confirms the leading `agent()` drain step still precedes `user()` at lines 96-101
    And the assertion invokes no paid LLM or ElevenLabs endpoint, so keyless-CI green proves the canonical shape is preserved, not skipped (AC8)

  @e2e @ts-elevenlabs
  Scenario: The hosted single-exchange recipe passes live with keys set
    Given `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, and `OPENAI_API_KEY` are all set
    When the greeting-led `agent()→user→agent→judge` test at elevenlabs-hosted.test.ts:96-101 runs
    Then the vitest summary line shows the hosted test PASSED, not skipped
    And the script at lines 96-101 is unchanged after the docs/code work (AC8)

  @unit
  Scenario: The composable multi-turn shape is provable in keyless CI without live keys
    Given the composable multi-turn recipe at elevenlabs-hosted.test.ts:184-190 with two `user↔agent` exchanges
    When the ungated mock-transport / shape assertion runs in keyless CI
    Then it confirms two scripted `user→agent` exchanges are dispatched without live keys
    And keyless-CI green therefore means the multi-turn path was registered and exercised, not skipped (AC9)

  @e2e @ts-elevenlabs
  Scenario: The composable multi-turn recipe passes live with keys set
    Given `ELEVENLABS_API_KEY` and `OPENAI_API_KEY` are set for the branded composable path
    When the two-exchange recipe at elevenlabs-hosted.test.ts:184-190 runs
    Then the vitest summary line shows the branded composable test PASSED, not skipped (AC9)

  # ============================================================
  # AC Coverage Map
  # ============================================================
  # AC1  (hosted ceiling stated in multi-turn.mdx — `not supported on hosted` + `elevenLabsAgent`)
  #      -> Scenario: A reader of the multi-turn recipe learns the hosted ceiling and is routed to a working adapter
  #      -> Scenario: The multi-turn recipe carries the hosted-NOT-supported caveat as a grep-gated invariant
  # AC2  (getting-started.mdx hosted caveat within 3 lines of each proceed()
  #      -> Scenario: The getting-started page caveats proceed() against hosted ConvAI next to each occurrence
  # AC3  (troubleshooting.mdx `receiveAudio timed out` entry — server-VAD ceiling + greeting-drain rule)
  #      -> Scenario: A developer hitting the hosted timeout finds the diagnosis and the greeting-drain fix
  #      -> Scenario: The troubleshooting timeout and duration-warning entries are grep-gated
  # AC4a (happy-path-elevenlabs.mdx greeting-led agent()→user→agent→judge, agent() precedes first user())
  #      -> Scenario: The happy-path doc teaches the greeting-led single exchange
  #      -> Scenario: The happy-path script is grep-gated to greeting-led order
  # AC4b (python + TS hosted examples identical greeting-led script; no "single-turn" docstring above a 2nd user())
  #      -> Scenario: The python and TS hosted examples share one greeting-led script with no self-contradicting docstring
  # AC5  (troubleshooting.mdx duration-mismatch / non-continuous warning documented as benign server-side)
  #      -> Scenario: A developer hitting the hosted timeout finds the diagnosis and the greeting-drain fix
  #      -> Scenario: The troubleshooting timeout and duration-warning entries are grep-gated
  # AC6  (2nd scripted user turn yields "hosted ConvAI" + single-exchange + anchor, OR linked decision record)
  #      -> Scenario: A 2nd scripted user turn on hosted elevenLabsAgent fails informatively, not with a bare timeout
  # AC7  (louder warning on text passthrough to a voice agent-under-test, OR struck on reporter config quote)
  #      -> Scenario: A voice agent-under-test receiving a text user turn gets a louder warning than silent passthrough
  # AC8  (greeting-led hosted script at elevenlabs-hosted.test.ts:96-101 unchanged + ungated CI shape assertion)
  #      -> Scenario: The hosted single-exchange shape is provable in keyless CI without a paid endpoint
  #      -> Scenario: The hosted single-exchange recipe passes live with keys set
  # AC9  (composable multi-turn at elevenlabs-hosted.test.ts:184-190 passes live + ungated two-exchange assertion)
  #      -> Scenario: The composable multi-turn shape is provable in keyless CI without live keys
  #      -> Scenario: The composable multi-turn recipe passes live with keys set
  # AC10 (resolving comment answers the 3 reporter questions, each tied to a docs anchor)
  #      -> Scenario: The resolving comment answers the reporter's three questions, each tied to a docs anchor
  # AC11 (multi-turn.mdx positive routing to composable/pipecat/gemini/realtime + worked link to a non-hosted test)
  #      -> Scenario: A reader of the multi-turn recipe learns the hosted ceiling and is routed to a working adapter
  #      -> Scenario: The multi-turn recipe's positive-routing line is grep-gated to a composable adapter
