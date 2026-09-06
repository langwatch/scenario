// Cross-language parity guard for the audio example judge criteria (#680, #682).
//
// The four audio example siblings (JS audio-to-audio, JS audio-to-text, Python
// audio-to-text, Python audio-to-audio) must judge against byte-identical
// criteria. #655/#612 aligned three of them by copy-paste, #680 found two
// latent gaps that had to be fixed in all three at once, and #682 found the
// fourth still carrying the pre-alignment criteria a year later. There is now
// one constant per language and this test holds the two together, so no copy
// can drift and no sibling can fall out of the set unnoticed. It is fully
// deterministic (file read + parse, no API keys, no network), so it runs in CI
// unlike the live-only examples it guards.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { AUDIO_JUDGE_CRITERIA } from "./helpers/audio-judge-criteria";

const PYTHON_CRITERIA_MODULE = fileURLToPath(
  new URL(
    "../../../../python/examples/helpers/audio_judge_criteria.py",
    import.meta.url,
  ),
);

const JS_SIBLINGS = [
  "multimodal-audio-to-audio.test.ts",
  "multimodal-audio-to-text.test.ts",
];

// Whether the Python siblings actually USE their constant is checked where it
// can be checked properly: python/tests/test_audio_example_judge_criteria.py
// walks each example's AST and inspects every JudgeAgent call. Text matching
// from here could not see a second judge with an inline list, a local rebinding
// that shadows the import, or an import that stopped coming from `helpers`.

/**
 * Extract the `AUDIO_JUDGE_CRITERIA = (...)` literal from the Python module.
 *
 * The Python tuple is written as double-quoted string literals precisely so it
 * parses as JSON once the parentheses are swapped for brackets and the trailing
 * comma is dropped. See the warning in that module's docstring. The annotation
 * between the name and the `=` is deliberately not pinned here: what this guard
 * is about is the criteria, and a stricter pattern would fail as a rename of the
 * type rather than as the drift it exists to catch.
 */
function readPythonCriteria(): string[] {
  const source = readFileSync(PYTHON_CRITERIA_MODULE, "utf8");
  const match = /^AUDIO_JUDGE_CRITERIA[^=\n]*= \(\n(.*?)^\)$/ms.exec(source);
  expect(
    match,
    `could not find an 'AUDIO_JUDGE_CRITERIA = (' tuple literal in ${PYTHON_CRITERIA_MODULE}. ` +
      "if it was renamed or reformatted, update this parity guard rather than deleting it",
  ).not.toBeNull();

  const body = match![1].trimEnd().replace(/,$/, "");
  try {
    return JSON.parse(`[${body}]`) as string[];
  } catch (error) {
    throw new Error(
      `AUDIO_JUDGE_CRITERIA in ${PYTHON_CRITERIA_MODULE} is not JSON-parseable. The criteria ` +
        "must be plain double-quoted Python string literals (no single quotes, no " +
        `concatenation, no f-strings) so this parity guard can read them. Cause: ${String(error)}`,
    );
  }
}

describe("audio example judge criteria — cross-language parity", () => {
  it("keeps the Python constant byte-identical to the shared JS one", () => {
    expect(readPythonCriteria()).toEqual([...AUDIO_JUDGE_CRITERIA]);
  });

  // Sharing the constant only helps while the siblings actually USE it. Nothing
  // stops a future edit from pasting a criteria literal back inline — which is
  // precisely how the three copies #680 was filed for came to exist.
  it.each(JS_SIBLINGS)("keeps %s on the shared constant, not an inline copy", (sibling) => {
    const source = readFileSync(
      fileURLToPath(new URL(`./${sibling}`, import.meta.url)),
      "utf8",
    );
    // Assert on what is HANDED TO THE JUDGE, not merely that the import is
    // present — a sibling can import the constant and still pass an inline
    // array, which would satisfy a bare "contains" check while drifting.
    expect(
      source,
      `${sibling} must pass AUDIO_JUDGE_CRITERIA to the judge, not an inline array`,
    ).toMatch(
      // \b after the direct form matters: without it, a drifted
      // `criteria: AUDIO_JUDGE_CRITERIA_STALE` would satisfy the match. The
      // spread form needs no such guard — the `]` already delimits it.
      /\bcriteria\s*:\s*(?:AUDIO_JUDGE_CRITERIA\b|\[\s*\.\.\.AUDIO_JUDGE_CRITERIA\s*\])/,
    );
    expect(
      source,
      `${sibling} inlines a judge criterion again — import AUDIO_JUDGE_CRITERIA instead`,
    ).not.toContain("The agent's response demonstrates");
  });

  it("still carries the #680 tightenings the siblings were fixed for", () => {
    const [contentSpecific, coherent] = AUDIO_JUDGE_CRITERIA;

    // Criterion 1: a bare "I heard your audio" must not be enough.
    expect(contentSpecific).toContain("does NOT satisfy this criterion on its own");
    expect(contentSpecific).not.toContain("acknowledges what it heard");

    // Criterion 2: a courteous "I can't process audio" is excluded explicitly,
    // rather than left to the reader's definition of "refusal".
    expect(coherent).toContain("polite deflection");
  });
});
