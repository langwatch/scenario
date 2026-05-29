Feature: User-facing docs surface for the voice-agent adapter system
  As a developer discovering Scenario's voice testing support
  I want a published docs section that explains adapters, ships a copy-pasteable
  first scenario, lists per-adapter capabilities, and diagnoses common failures
  So that I can run my first voice scenario in 60 seconds without reading
  the 835-line proposal or the 99-scenario feature file
  And so the docs site stops surfacing the deprecated gpt-4o-audio-preview path
  as the primary voice entrypoint

  Background:
    Given the Scenario Vocs docs site is configured at docs/vocs.config.tsx
    And the VoiceAgentAdapter system shipped by #350 / PR #355 is the canonical voice path
    And the legacy OpenAiVoiceAgent / gpt-4o-audio-preview pages exist under docs/docs/pages/examples/multimodal/

  # ============================================================
  # Group: Getting started
  # ============================================================

  @e2e
  Scenario: A new user reaches a runnable first voice scenario from the docs site
    Given a developer visiting the Scenario Vocs site
    When they open the Voice Agents section and click Getting Started
    Then the page lists the install command, required env vars, and a single copy-pasteable Python snippet
    And the snippet runs end-to-end with only OPENAI_API_KEY set
    And the page links to the recipes index for next steps

  @integration
  Scenario: The getting-started snippet is source-derived, not hand-typed into MDX
    Given the canonical example lives at python/examples/voice/getting_started.py
    When the Vocs site is built
    Then the Getting Started MDX page imports the snippet from the example file via the mdx-examples-manifest.js pipeline
    And editing python/examples/voice/getting_started.py changes the rendered snippet on the next build

  @integration
  Scenario: CI fails when the getting-started snippet stops importing
    Given the getting-started example is exercised by an import-check test under python/tests/voice/test_docs_getting_started.py
    When a refactor breaks an import or a symbol in python/examples/voice/getting_started.py
    Then the test wrapper fails on python-ci.yml
    And the failure surfaces before the docs can ship a silently-broken snippet
    And the test does not invoke any paid LLM endpoint or trip voice-integration.yml collection rules

  # ============================================================
  # Group: Capability matrix
  # ============================================================

  @e2e
  Scenario: Capability matrix is published as a navigable reference page
    Given a developer comparing voice adapters
    When they open the /voice/capability-matrix page on the published docs site
    Then the page renders a table with one row per shipped adapter and one row per stubbed adapter
    And stubbed adapters carry a PendingTransportError note
    And the table columns include streaming_transcripts, native_vad, dtmf, interruption, input_formats, and output_formats

  @integration
  Scenario: Capability matrix cannot silently drift from AdapterCapabilities
    Given python/scripts/gen_capability_matrix.py introspects every adapter's AdapterCapabilities ClassVar
    And the generator writes the table between markers into docs/docs/pages/_generated/voice/capability-matrix.mdx
    When an adapter's capability fields change and the generated file is not regenerated
    Then python-ci.yml fails on the git-diff gate
    And the failure points the contributor at the regen command

  # ============================================================
  # Group: Adapter selection guide
  # ============================================================

  @e2e
  Scenario: A reader picks an adapter from a use-case decision tree
    Given a developer who knows their use case but not which adapter fits
    When they open docs/voice/choosing-an-adapter on the published site
    Then the page presents a decision tree covering Twilio IVR, OpenAI Realtime, custom Pipecat bots, latency benchmarks, and branded ElevenLabs voice
    And each branch resolves to a single recommended adapter

  @e2e
  Scenario: Each use case links to a runnable demo
    Given the choosing-an-adapter page lists five use cases
    When the reader follows the worked-example link on any use case
    Then the link resolves to a file under python/examples/voice/ that demonstrates the recommended adapter
    And the demo file's docstring states what it proves

  # ============================================================
  # Group: Recipes / how-tos
  # ============================================================

  @e2e
  Scenario: Interruption recipe documents both forms of scenario.interrupt() and barge-in modes
    Given a developer wanting to script an interrupt
    When they open docs/voice/recipes/interrupt on the published site
    Then the page explains the unrolled and sugar forms of scenario.interrupt()
    And the page distinguishes native barge-in from VAD-driven barge-in
    And the page links to the relevant python/examples/voice/ demo

  @e2e
  Scenario: Multi-turn recipe shows scripted turns and judge continuity criteria
    Given a developer building a multi-turn voice test
    When they open docs/voice/recipes/multi-turn on the published site
    Then the page demonstrates a 2-turn script with judge continuity criteria
    And the page reflects the 2-turn extension landed in commit 5579aa5
    And the page links to the relevant python/examples/voice/ demo

  @e2e
  Scenario: Effects recipe documents background noise and per-step overrides
    Given a developer who wants to inject audio effects into a turn
    When they open docs/voice/recipes/effects on the published site
    Then the page shows how to apply background noise and audio effects
    And the page shows how to override effects per step
    And the page links to the relevant python/examples/voice/ demo

  @e2e
  Scenario: Observability recipe documents hooks, audio.save(), and latency metrics
    Given a developer instrumenting a voice scenario for capture
    When they open docs/voice/recipes/observability on the published site
    Then the page documents the on_audio_chunk and on_voice_event hooks
    And the page documents result.audio.save() and the LatencyMetrics surface
    And the page links to the relevant python/examples/voice/ demo

  # ============================================================
  # Group: Troubleshooting
  # ============================================================

  @e2e
  Scenario: Troubleshooting page lists each documented failure mode with diagnosis and fix
    Given a developer hitting a voice-scenario failure
    When they open docs/voice/troubleshooting on the published site
    Then the page covers ElevenLabs HTTP 401 quota_exceeded with a top-up link
    And the page covers Twilio HTTP 401 code 20003 with a token-rotation fix
    And the page covers Gemini Live agent-reply ~60 bytes on turn 2+ with a reference to commit 80461e2
    And the page covers VAD-didn't-fire with threshold-tuning guidance and the webrtcvad-wheels fallback
    And the page covers ffmpeg-not-found with the imageio-ffmpeg install path
    And the page covers empty demo recordings with the outputs/recordings/<demo>/manifest.json check

  # ============================================================
  # Group: Docs site integration
  # ============================================================

  @integration
  Scenario: New voice section replaces the legacy Multimodal voice sub-tree in the sidebar
    Given docs/vocs.config.tsx currently lists Multimodal -> Voice Agents at lines ~391-416
    When the new Voice Agents sidebar group is wired
    Then the sidebar exposes Getting Started, Capability Matrix, Choosing an Adapter, Recipes, and Troubleshooting as primary nav entries
    And the legacy Multimodal -> Voice Agents group is removed from the sidebar config

  @integration
  Scenario: The voice docs cross-link to the proposal and the behavioral contract
    Given the Voice Agents docs section is published
    When a reader opens Getting Started or Choosing an Adapter
    Then the page links to docs/proposals/issue-350-voice-agents-source.md for design context
    And the page links to specs/voice-agents.feature for the 99-scenario behavioral contract

  # ============================================================
  # Group: Legacy OpenAiVoiceAgent / gpt-4o-audio-preview deprecation
  # ============================================================

  @integration
  Scenario: Deprecated multimodal pages stay reachable by URL
    Given the legacy pages voice-to-voice.mdx, audio-to-audio.mdx, audio-to-text.mdx, and testing-voice-agents.mdx
    When the Vocs site is built after the deprecation pass
    Then each page still resolves to its original URL on the published site
    And no 404 is produced for inbound links from Google or external sites

  @integration
  Scenario: Deprecated multimodal pages no longer appear in the sidebar
    Given docs/vocs.config.tsx lines ~391-416 currently list Multimodal -> Voice Agents
    When the deprecation pass is complete
    Then the sidebar no longer surfaces those pages as primary nav
    And the only way to land on them is via a deep link or the redirect banner

  @integration
  Scenario: A deprecation banner appears on every legacy voice page
    Given the four legacy multimodal voice pages
    When a reader opens any of them
    Then the page renders a deprecation callout at the top
    And the callout points to docs/voice/getting-started as the canonical entrypoint
    And the banner text comes from a single shared MDX snippet so future edits propagate

  @integration
  Scenario: Legacy example file in the repo signposts users to the canonical voice demos
    Given python/examples/test_voice_to_voice_conversation.py is the legacy voice example in the repo
    When a developer opens that file
    Then a header docstring (or an adjacent DEPRECATED.md) points at python/examples/voice/* as the canonical demos
    And the source file is not deleted

  # ============================================================
  # AC Coverage Map
  # ============================================================
  # AC 1  (Getting started page: installs, env-var checklist, runnable example, link to recipes)
  #       -> Scenario: A new user reaches a runnable first voice scenario from the docs site
  # AC 2  (One copy-pasteable Python snippet runs against OPENAI_API_KEY only)
  #       -> Scenario: A new user reaches a runnable first voice scenario from the docs site
  # AC 3  (Snippet is doctest-validatable OR has matching tests/voice/test_docs_* wrapper)
  #       -> Scenario: The getting-started snippet is source-derived, not hand-typed into MDX
  #       -> Scenario: CI fails when the getting-started snippet stops importing
  # AC 4  (Capability matrix page with rows per adapter and listed columns)
  #       -> Scenario: Capability matrix is published as a navigable reference page
  # AC 5  (Reference auto-generated from adapter.capabilities OR CI check that table matches code)
  #       -> Scenario: Capability matrix cannot silently drift from AdapterCapabilities
  # AC 6  (Choosing-an-adapter page with decision tree by use case)
  #       -> Scenario: A reader picks an adapter from a use-case decision tree
  # AC 7  (One worked example per use case linking to python/examples/voice/)
  #       -> Scenario: Each use case links to a runnable demo
  # AC 8  (recipes/interrupt.md: scenario.interrupt(), unrolled+sugar forms, native vs VAD barge-in)
  #       -> Scenario: Interruption recipe documents both forms of scenario.interrupt() and barge-in modes
  # AC 9  (recipes/multi-turn.md: multi-turn scripting + judge continuity, 2-turn extension via #5579aa5)
  #       -> Scenario: Multi-turn recipe shows scripted turns and judge continuity criteria
  # AC 10 (recipes/effects.md: background noise + audio effects + per-step overrides)
  #       -> Scenario: Effects recipe documents background noise and per-step overrides
  # AC 11 (recipes/observability.md: on_audio_chunk/on_voice_event hooks, result.audio.save(), latency metrics)
  #       -> Scenario: Observability recipe documents hooks, audio.save(), and latency metrics
  # AC 12 (troubleshooting.md: six concrete failure modes with diagnosis + fix)
  #       -> Scenario: Troubleshooting page lists each documented failure mode with diagnosis and fix
  # AC 13 (New voice section wired into Vocs sidebar, replaces Multimodal -> Voice Agents sub-tree)
  #       -> Scenario: New voice section replaces the legacy Multimodal voice sub-tree in the sidebar
  # AC 14 (Cross-links to the proposal and to the feature file)
  #       -> Scenario: The voice docs cross-link to the proposal and the behavioral contract
  # AC 15 (Deprecated pages stay live, preserving SEO + inbound links)
  #       -> Scenario: Deprecated multimodal pages stay reachable by URL
  # AC 16 (Remove deprecated pages from Vocs sidebar at lines ~391-416)
  #       -> Scenario: Deprecated multimodal pages no longer appear in the sidebar
  # AC 17 (Deprecation banner at the top of each deprecated page, single source)
  #       -> Scenario: A deprecation banner appears on every legacy voice page
  # AC 18 (Repo-side header docstring/DEPRECATED.md on python/examples/test_voice_to_voice_conversation.py)
  #       -> Scenario: Legacy example file in the repo signposts users to the canonical voice demos
