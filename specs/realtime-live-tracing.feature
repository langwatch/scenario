Feature: LangWatch tracing for live OpenAI Realtime apps
  As a developer who uses OpenAI Realtime in production
  I want a packaged helper that wraps my Realtime session in LangWatch spans
  So that I get the same observability story in my live app as I do in scenario tests

  # --- AC1, AC9 ---
  @unit
  Scenario: realtime_langwatch_session is importable from scenario
    Given the scenario package is installed
    When `from scenario import realtime_langwatch_session` is executed
    Then the import succeeds without error
    And importing scenario alone does not create a TracerProvider (provider type is ProxyTracerProvider)

  # --- AC2 ---
  @unit
  Scenario: log_turn emits a child LLM span with correct attributes and name
    Given an InMemorySpanExporter is installed on the current TracerProvider
    And LANGWATCH_API_KEY is set in the environment
    When realtime_langwatch_session is entered as an async context manager
    And log_turn is called with user_transcript "Hello", agent_transcript "Hi there", model "gpt-4o-realtime-preview", latency_ms 450
    Then the InMemorySpanExporter records exactly 1 finished span
    And that span has name "realtime_turn"
    And that span has attribute type = "llm"
    And that span has attribute input = "Hello"
    And that span has attribute output = "Hi there"
    And that span has attribute model = "gpt-4o-realtime-preview"
    And that span has attribute latency_ms = 450

  # --- AC3 ---
  @unit
  Scenario: no-op when LANGWATCH_API_KEY is absent
    Given LANGWATCH_API_KEY is not set in the environment
    And an InMemorySpanExporter is installed on the current TracerProvider
    When realtime_langwatch_session is entered as an async context manager
    And log_turn is called with any transcripts
    Then no exception is raised
    And the InMemorySpanExporter records 0 finished spans

  # --- AC4 ---
  @unit
  Scenario: helper module has no import from scenario._tracing.setup
    When the source of scenario/_tracing/live.py is inspected
    Then the file exists (test -f scenario/_tracing/live.py exits 0)
    And it contains no line matching "^from.*_tracing.setup" or "^import.*_tracing.setup"
    And realtime_langwatch_session can be used in a process where scenario.run() was never called

  # --- AC5a ---
  @unit
  Scenario: creates new TracerProvider when no prior setup exists
    Given OTel state is reset to a fresh ProxyTracerProvider
    And LANGWATCH_API_KEY is set in the environment
    When realtime_langwatch_session is entered as an async context manager
    Then trace.get_tracer_provider() returns an instance of TracerProvider (not ProxyTracerProvider)

  # --- AC5b ---
  @unit
  Scenario: attaches to existing TracerProvider without replacing it
    Given langwatch.setup() has already been called (existing concrete TracerProvider)
    And the existing provider id is captured
    And an InMemorySpanExporter is added to the existing provider
    When realtime_langwatch_session is entered as an async context manager
    Then trace.get_tracer_provider() id is unchanged (same object)
    And log_turn emits a span captured by the InMemorySpanExporter on the existing provider

  # --- AC6 ---
  @unit
  Scenario: OTLP export failure does not propagate to the live app
    Given LANGWATCH_API_KEY is set in the environment
    And the span processor's on_end method is mocked to raise RuntimeError
    When realtime_langwatch_session is entered as an async context manager
    And log_turn is called
    Then no exception propagates out of the async with block or log_turn call
    And at least one WARNING record is emitted from logger "scenario.tracing"

  # --- AC7 ---
  @unit
  Scenario: log_turn before entering context raises RuntimeError
    Given a realtime_langwatch_session instance
    When log_turn is called before __aenter__ is called
    Then RuntimeError is raised with message containing "realtime_langwatch_session"

  @unit
  Scenario: log_turn after exiting context raises RuntimeError
    Given a realtime_langwatch_session instance
    And the context has been entered and exited
    When log_turn is called after __aexit__ returns
    Then RuntimeError is raised with message containing "realtime_langwatch_session"

  # --- AC8 ---
  @unit
  Scenario: happy-path-openai-realtime doc contains live app tracing section
    When docs/docs/pages/voice/happy-path-openai-realtime.mdx is read
    Then it contains a "## Getting LangWatch traces from your live app" heading
    And the code block immediately under that heading contains "async with realtime_langwatch_session("
    And the awk-extracted block under that heading contains only OPENAI_API_KEY and LANGWATCH_API_KEY as *_KEY env var names (grep -oE '[A-Z_]+_KEY' returns exactly those two, sorted)

  # --- AC9 (covered in first scenario above) ---

  # --- AC10 ---
  @unit
  Scenario: run-then-helper coexistence — no duplicate TracerProvider
    Given ensure_tracing_initialized() has been called (simulating scenario.run())
    And the provider id is captured
    When realtime_langwatch_session is entered as an async context manager
    Then no exception is raised
    And trace.get_tracer_provider() id is unchanged (same object as before)

  # --- AC11 ---
  @unit
  Scenario: helper-then-run coexistence — run() proceeds after helper exits
    Given realtime_langwatch_session has been entered and exited
    When ensure_tracing_initialized() is called
    Then no exception is raised
    And _initialized from scenario._tracing.setup is True
    And a subsequent scenario.run() call does not raise an OTel conflict (returns a ScenarioResult or completes the run() call body without raising)

  # --- AC12 ---
  @unit
  Scenario: log_turn accepts empty transcripts and zero latency without error
    Given LANGWATCH_API_KEY is set in the environment
    And an InMemorySpanExporter is installed
    When realtime_langwatch_session is entered as an async context manager
    And log_turn is called with user_transcript="", agent_transcript="", model="gpt-4o-realtime-preview", latency_ms=0
    Then no exception is raised
    And the InMemorySpanExporter records exactly 1 finished span

  # --- AC13 ---
  @unit
  Scenario: multiple sequential log_turn calls each emit one independent span
    Given LANGWATCH_API_KEY is set in the environment
    And an InMemorySpanExporter is installed on the current TracerProvider
    When realtime_langwatch_session is entered as an async context manager
    And log_turn is called with user_transcript "Turn 1 user", agent_transcript "Turn 1 agent", model "gpt-4o-realtime-preview", latency_ms 100
    And log_turn is called again with user_transcript "Turn 2 user", agent_transcript "Turn 2 agent", model "gpt-4o-realtime-preview", latency_ms 200
    Then the InMemorySpanExporter records exactly 2 finished spans
    And the first span has attribute input = "Turn 1 user" and output = "Turn 1 agent" and latency_ms = 100
    And the second span has attribute input = "Turn 2 user" and output = "Turn 2 agent" and latency_ms = 200

  # --- AC14 ---
  @unit
  Scenario: __aexit__ flushes spans and leaves no half-configured provider
    Given LANGWATCH_API_KEY is set in the environment
    And an InMemorySpanExporter is installed
    When realtime_langwatch_session is entered and log_turn is called inside it
    And the async context is exited (__aexit__ completes)
    Then the span emitted by log_turn is present in InMemorySpanExporter.get_finished_spans() after the with block (not only mid-block)
    And __aexit__ does not raise even if no turns were logged

# --- AC Coverage Map ---
# AC1:  "scenario.realtime_langwatch_session is the public importable name"
#       → Scenario: realtime_langwatch_session is importable from scenario
# AC2:  "log_turn emits child LLM span with correct attributes and name"
#       → Scenario: log_turn emits a child LLM span with correct attributes and name
# AC3:  "no-op when LANGWATCH_API_KEY is absent"
#       → Scenario: no-op when LANGWATCH_API_KEY is absent
# AC4:  "no import from scenario._tracing.setup"
#       → Scenario: helper module has no import from scenario._tracing.setup
# AC5a: "creates new TracerProvider when no prior setup exists"
#       → Scenario: creates new TracerProvider when no prior setup exists
# AC5b: "attaches to existing TracerProvider without replacing it"
#       → Scenario: attaches to existing TracerProvider without replacing it
# AC6:  "OTLP export failure does not propagate to the live app"
#       → Scenario: OTLP export failure does not propagate to the live app
# AC7:  "log_turn outside context raises RuntimeError"
#       → Scenario: log_turn before entering context raises RuntimeError
#       → Scenario: log_turn after exiting context raises RuntimeError
# AC8:  "happy-path-openai-realtime.mdx gains live app tracing section"
#       → Scenario: happy-path-openai-realtime doc contains live app tracing section
# AC9:  "importing scenario does not create TracerProvider at import time"
#       → Scenario: realtime_langwatch_session is importable from scenario (second Then)
# AC10: "run-then-helper coexistence — no duplicate TracerProvider"
#       → Scenario: run-then-helper coexistence — no duplicate TracerProvider
# AC11: "helper-then-run coexistence — run() proceeds after helper exits"
#       → Scenario: helper-then-run coexistence — run() proceeds after helper exits
# AC12: "log_turn accepts empty transcripts and zero latency without error"
#       → Scenario: log_turn accepts empty transcripts and zero latency without error
# AC13: "multiple sequential log_turn calls each emit one independent span"
#       → Scenario: multiple sequential log_turn calls each emit one independent span
# AC14: "__aexit__ flushes spans and leaves no half-configured provider"
#       → Scenario: __aexit__ flushes spans and leaves no half-configured provider
