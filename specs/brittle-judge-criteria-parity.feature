Feature: Remove brittle judge criteria from audio-to-audio and Python audio-to-text examples
  As a contributor running live audio example tests
  I want the LLM-judge criteria to test observable pipeline behavior rather than exact model output
  So that correct agents that paraphrase or hedge do not produce false failures

  Background:
    Given the file `javascript/examples/vitest/tests/multimodal-audio-to-audio.test.ts`
    And the file `python/examples/test_audio_to_text.py`
    And the reference file `javascript/examples/vitest/tests/multimodal-audio-to-text.test.ts`
      with the 3 generic criteria at lines 110–114

  # --- AC 1: TS brittle strings removed ---

  @unit
  Scenario: TS audio-to-audio criteria array contains none of the brittle strings
    Given the `scenario.judge({ criteria: [...] })` script step in `multimodal-audio-to-audio.test.ts`
    When the criteria array is inspected
    Then it contains no string matching `"correctly guesses"`
    And it contains no string matching `"repeats the question"`
    And it contains no string matching `"says what format"`

  # --- AC 2: Python brittle strings removed ---

  @unit
  Scenario: Python audio-to-text JudgeAgent criteria contain none of the brittle strings
    Given the `scenario.JudgeAgent(criteria=[...])` constructor in `test_audio_to_text.py`
    When the criteria list is inspected
    Then it contains no string matching `"correctly guesses"`
    And it contains no string matching `"repeats the question"`
    And it contains no string matching `"says what format"`

  # --- AC 3: Replacements are the validated generic set from the fixed sibling ---

  @unit
  Scenario: TS audio-to-audio criteria are byte-identical to the fixed sibling's generic criteria
    Given the `criteria` array in `multimodal-audio-to-audio.test.ts` after the change
    And the `criteria` array in `multimodal-audio-to-text.test.ts` lines 110–114
    When the two arrays are diffed
    Then the diff is empty — the arrays are byte-identical

  @unit
  Scenario: Python audio-to-text criteria are a faithful translation of the same 3 generic assertions
    Given the `criteria` list in `test_audio_to_text.py` after the change
    And the 3 generic criteria from `multimodal-audio-to-text.test.ts:110–114`
    When the Python list is compared to the TS sibling strings
    Then it contains exactly 3 criteria
    And each criterion expresses the same behavioral assertion as its TS counterpart (audio processed / coherent response / indicates non-text input)
    And no new assertion is introduced

  # --- AC 4: Criteria edited only at the correct call sites ---

  @unit
  Scenario: TS criteria are placed only in the scenario.judge script step, not in judgeAgent constructor
    Given the diff for `multimodal-audio-to-audio.test.ts`
    When the changed lines are inspected
    Then the only modified lines are the `criteria` array inside `scenario.judge({ criteria: [...] })` at lines 82–86
    And the `scenario.judgeAgent({ model: ... })` call at line 69 has no `criteria` key added

  @unit
  Scenario: Python criteria are placed only in the JudgeAgent constructor, not in the script judge step
    Given the diff for `test_audio_to_text.py`
    When the changed lines are inspected
    Then the only modified lines are the `criteria` list inside `scenario.JudgeAgent(criteria=[...])` at lines 217–221
    And the bare `scenario.judge()` script step at line 239 remains a bare call with no `criteria` argument added

  # --- AC 5: No other test structure changes ---

  @unit
  Scenario: The change touches exactly two files and only the criteria array lines
    Given the full diff of the PR implementing this change
    When `git diff --stat` is run
    Then exactly two files are listed: `multimodal-audio-to-audio.test.ts` and `test_audio_to_text.py`
    And within each file, diff hunks fall only inside the criteria array line ranges (TS 82–86, Python 217–221)
    And no hunk touches the CI-skip guard lines, agent-class bodies, fixture-loading code, or the `script:`/`script=` step lists

  # --- Consequence AC: CI-skip guards preserved ---

  @unit
  Scenario: CI-skip guards are preserved in both files after the change
    Given the modified `multimodal-audio-to-audio.test.ts`
    When line 18 is inspected
    Then it contains `process.env.CI === "true"`

  @unit
  Scenario: Python CI-skip guard is preserved after the change
    Given the modified `test_audio_to_text.py`
    When line 29 is inspected
    Then it contains `os.environ.get("CI") == "true"`

# --- AC Coverage Map ---
# AC 1: "TS file criteria array contains none of the 3 brittle strings" → Scenario: TS audio-to-audio criteria array contains none of the brittle strings
# AC 2: "Python JudgeAgent criteria list contains none of the 3 brittle strings" → Scenario: Python audio-to-text JudgeAgent criteria contain none of the brittle strings
# AC 3a: "TS criteria are byte-identical to sibling lines 110–114" → Scenario: TS audio-to-audio criteria are byte-identical to the fixed sibling's generic criteria
# AC 3b: "Python criteria are faithful translation of the same 3 strings" → Scenario: Python audio-to-text criteria are a faithful translation of the same 3 generic assertions
# AC 4: "Criteria edited only at the correct call sites (TS 82-86, Python 217-221); bare calls not given criteria args" → Scenario: TS criteria are placed only in the scenario.judge script step ... + Scenario: Python criteria are placed only in the JudgeAgent constructor ...
# AC 5: "No other test structure changes; diff touches only 2 files, only criteria array line ranges" → Scenario: The change touches exactly two files and only the criteria array lines
# AC (consequence): "CI-skip guards preserved in both files" → Scenario: CI-skip guards are preserved ... + Scenario: Python CI-skip guard is preserved ...
