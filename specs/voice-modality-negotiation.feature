Feature: Per-role voice modality negotiation (observable spine)
  As a voice-scenario author
  I want simulator and judge modality resolved per role from declaration, model, and adapter capabilities
  So that audio-capable models actually hear audio and any degraded mode is loud and observable, never silent

  # Issue: https://github.com/langwatch/scenario/issues/666
  # Out of scope (separate issues): realtime<->realtime audio bus, shared-transcript collapse.

  @integration
  Scenario: Per-role modality declaration is settable through the public API
    Given a scenario configured via the public per-role modality parameter (e.g. modality=) for the simulator and the judge
    When modality is resolved for each role
    Then each role's resolution result reflects the publicly declared modality
    And the parameter is documented in the user-facing docs

  @unit
  Scenario: Audio-capable simulator receives audio content parts
    Given a user simulator whose resolved modality is audio-in (e.g. model "gpt-audio-mini", no contrary declaration)
    And a conversation containing assistant messages with input_audio content parts
    When the simulator generates its next turn
    Then the message payload passed to the LLM completion call retains the input_audio content parts
    And the text content parts are intact and unmodified

  @unit
  Scenario: Text-only simulator still has audio stripped with today's placeholders
    Given a user simulator whose resolved modality is text (text-only model, no declaration)
    And a conversation containing audio content parts
    When the simulator generates its next turn
    Then audio parts are stripped from the LLM payload
    And assistant messages with audio and text render as "[the agent said: <text>]"
    And audio-only messages render as "[audio message]"

  @unit
  Scenario: Judge audio capability is resolved, not substring-matched
    Given a judge configured with model "gpt-audio-mini" and audio present in the conversation
    When the judge prepares its evaluation call
    Then the judge receives the raw audio content parts

  @unit
  Scenario: gpt-4o judge with no declaration takes the transcript path (documented behavior change)
    Given a judge configured with model "gpt-4o", no modality declaration, and audio present in the conversation
    And litellm advisory reports the model as not audio-capable
    When the judge prepares its evaluation call
    Then the judge takes the post-hoc transcript path, not the raw-audio path
    And the behavior change versus the previous substring match is noted in the changelog or docs

  @unit
  Scenario: Judge explicit include_audio override still wins
    Given a judge with an audio-capable model and include_audio explicitly set to false
    When the judge prepares its evaluation call
    Then the judge does not receive raw audio parts and uses the transcript path

  @unit
  Scenario: Explicit declaration beats litellm advisory, with a loud warning
    Given a per-role modality declaration of audio-in for model "gpt-4o"
    And litellm capability data claims the model does not support audio input
    When modality is resolved for that role
    Then the declared audio-in modality is used
    And a warning is emitted naming the model, the declaration, and the contrary litellm opinion

  @unit
  Scenario: No silent degradation when detection disagrees with declaration
    Given a per-role declaration of text for a model litellm claims is audio-capable
    When modality is resolved for that role
    Then the declared text modality is used
    And a warning is emitted naming the mismatch

  @integration
  Scenario: Negotiated mode per role is stamped as OTEL span attributes
    Given a scenario run where the simulator resolves to audio-in and the judge resolves to STT-bridge
    When the run executes and spans are exported
    Then span attributes "scenario.modality.simulator.resolved" and "scenario.modality.simulator.tier" carry the simulator's resolution with tier "audio-in"
    And span attributes "scenario.modality.judge.resolved" and "scenario.modality.judge.tier" carry the judge's resolution with tier "stt-bridge"
    And the degraded role's tier value differs from the audio-in role's tier value

  @integration
  Scenario: Degradation to the STT bridge is an explicit, observed resolution outcome
    Given a role with declared or advisory audio-in modality
    And a stack that cannot honor audio-in but is not statically impossible
    When modality is resolved and the run executes
    Then the resolver selects "stt-bridge" for that role, not audio-in and not a failure
    And the STT fallback path actually executes for that role's turns (against the pre-#665 placeholder behavior if #665 is unmerged, stated in the test name)
    And the stamped tier attribute for that role reads "stt-bridge"

  @integration
  Scenario: Statically-impossible combo fails at scenario setup
    Given a declared realtime simulator and an adapter whose declared capabilities are mulaw/8000-only with no resample path
    When the scenario is assembled
    Then setup raises the specific modality-negotiation exception type
    And the exception message contains both the declared modality string "realtime" and the conflicting capability value "mulaw/8000"
    And no scenario turn executes

  @integration
  Scenario: Live transport mismatch fails at first connect, before the first turn
    Given declared capabilities that pass setup validation
    And a live transport that cannot honor them at connect (e.g. a stub adapter raising PendingTransportError)
    When the adapter connects
    Then the run fails before the first turn with the specific negotiation exception type
    And the exception message contains the negotiated-requirement token (e.g. "pcm16/24000" or "audio-in")
    And the run does not silently fall back to a different tier

  @integration
  Scenario: interrupt(after_words=N) validates against the negotiated stack
    Given a script using interrupt(after_words=3) on a stack whose negotiated capabilities lack streaming transcripts
    When the scenario reaches first connect
    Then an UnsupportedCapabilityError is raised no later than first connect, before the interrupt step executes
    And the error hint about using interrupt(content) without after_words is preserved

  @integration
  Scenario: dtmf gate behavior unchanged (regression)
    Given a script using dtmf() on an adapter without the dtmf capability
    When the step executes
    Then UnsupportedCapabilityError is raised exactly as before the change

  @integration
  Scenario: Judge post-hoc transcription from recorded audio remains the default for text judges
    Given a text-modality judge and a voice recording with audio segments
    When the judge evaluates the conversation
    Then transcribe_segments runs over the recording's segments
    And the judge reads transcripts derived from the recorded wire audio, not the simulator's intended text

  @unit
  Scenario: Capability matrix regeneration reflects any new capability field
    Given AdapterCapabilities gains a new field during implementation
    When the capability matrix generator runs
    Then the generated capability-matrix.mdx includes the new column
    And re-running the generator produces no diff against the committed file

  @unit
  Scenario: Capability matrix is byte-identical when no capability field is added
    Given AdapterCapabilities gains no new field during implementation
    When the capability matrix generator runs
    Then the generator output is byte-identical to the committed capability-matrix.mdx (git diff --exit-code clean)

# --- AC Coverage Map ---
# AC 0: "per-role declaration has a defined public surface" -> Scenario: Per-role modality declaration is settable through the public API
# AC 1: "audio-capable simulator hears audio" -> Scenario: Audio-capable simulator receives audio content parts
# AC 2: "text-only simulator still protected (regression)" -> Scenario: Text-only simulator still has audio stripped with today's placeholders
# AC 3: "per-role resolution, judge included (behavior change documented)" -> Scenarios: Judge audio capability is resolved, not substring-matched; gpt-4o judge with no declaration takes the transcript path (documented behavior change); Judge explicit include_audio override still wins
# AC 4: "declaration beats detection; advisory is loud, both directions" -> Scenarios: Explicit declaration beats litellm advisory, with a loud warning; No silent degradation when detection disagrees with declaration
# AC 5: "negotiated mode is observable (OTEL span attributes)" -> Scenario: Negotiated mode per role is stamped as OTEL span attributes
# AC 5b: "STT-bridge degradation is an explicit, observed resolution outcome" -> Scenario: Degradation to the STT bridge is an explicit, observed resolution outcome
# AC 6: "statically-impossible combo fails at setup" -> Scenario: Statically-impossible combo fails at scenario setup
# AC 7: "live-transport mismatch fails before the first turn" -> Scenario: Live transport mismatch fails at first connect, before the first turn
# AC 8: "script-feature gates validate against the negotiated stack" -> Scenarios: interrupt(after_words=N) validates against the negotiated stack; dtmf gate behavior unchanged (regression)
# AC 9: "judge codec-bug detection preserved" -> Scenario: Judge post-hoc transcription from recorded audio remains the default for text judges
# AC 10: "capability matrix stays truthful (incl. negative arm)" -> Scenarios: Capability matrix regeneration reflects any new capability field; Capability matrix is byte-identical when no capability field is added
