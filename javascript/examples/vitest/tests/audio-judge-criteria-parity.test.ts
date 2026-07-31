// Cross-language parity guard for the audio example judge criteria (#680).
//
// The three audio example siblings (JS audio-to-audio, JS audio-to-text, Python
// audio-to-text) must judge against byte-identical criteria — #655/#612 aligned
// them by copy-paste, and #680 found two latent gaps that had to be fixed in all
// three at once. The JS pair now shares one constant, so only the Python copy
// can drift; this test is the mechanism that stops it. It is fully deterministic
// (file read + parse, no API keys, no network), so it runs in CI unlike its
// live-only siblings.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { AUDIO_JUDGE_CRITERIA } from "./helpers/audio-judge-criteria";

const PYTHON_SIBLING = fileURLToPath(
  new URL("../../../../python/examples/test_audio_to_text.py", import.meta.url),
);

const JS_SIBLINGS = [
  "multimodal-audio-to-audio.test.ts",
  "multimodal-audio-to-text.test.ts",
];

/**
 * Extract the `AUDIO_JUDGE_CRITERIA = [...]` literal from the Python sibling.
 *
 * The Python list is written as double-quoted string literals precisely so it
 * parses as JSON once the trailing comma is dropped — see the ⚠ note next to the
 * declaration in that file.
 */
function readPythonCriteria(): string[] {
  const source = readFileSync(PYTHON_SIBLING, "utf8");
  const match = /^AUDIO_JUDGE_CRITERIA = \[\n(.*?)^\]$/ms.exec(source);
  expect(
    match,
    `could not find an 'AUDIO_JUDGE_CRITERIA = [' list literal in ${PYTHON_SIBLING} — ` +
      "if it was renamed or reformatted, update this parity guard rather than deleting it",
  ).not.toBeNull();

  const body = match![1].trimEnd().replace(/,$/, "");
  try {
    return JSON.parse(`[${body}]`) as string[];
  } catch (error) {
    throw new Error(
      `AUDIO_JUDGE_CRITERIA in ${PYTHON_SIBLING} is not JSON-parseable — the criteria ` +
        "must be plain double-quoted Python string literals (no single quotes, no " +
        `concatenation, no f-strings) so this parity guard can read them. Cause: ${String(error)}`,
    );
  }
}

describe("audio example judge criteria — cross-language parity", () => {
  it("keeps the Python sibling byte-identical to the shared JS constants", () => {
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
    expect(source).toContain("AUDIO_JUDGE_CRITERIA");
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
