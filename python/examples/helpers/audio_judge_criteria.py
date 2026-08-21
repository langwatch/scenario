"""
Shared LLM-judge criteria for the audio example scenarios.

WHY THIS EXISTS: four sibling examples (JS audio-to-audio, JS audio-to-text,
Python audio-to-text, Python audio-to-audio) judge the same capability. #655
and #612 aligned three of them by copy-paste, #680 then found two latent gaps
that had to be fixed in all three at once, and #682 found the fourth sibling
still carrying the pre-alignment criteria. Copies drift, so there is now one
copy per language and a parity test that keeps the two byte-identical:
`javascript/examples/vitest/tests/audio-judge-criteria-parity.test.ts`.

Keep in sync with `javascript/examples/vitest/tests/helpers/audio-judge-criteria.ts`.

WHY THE WORDING IS DEFENSIVE (#680):
  - Criterion 1 used to accept "acknowledges what it heard", which let a
    broken pipeline pass: empty audio in, "I received your audio" out.
  - Criterion 3 is satisfied by a polite deflection ("sorry, I can't process
    audio files") because that too names the non-text format, so criterion 2
    has to exclude deflection explicitly rather than leaning on "refusal".

WHY A TUPLE: an importer can mutate a shared list in place, and doing so binds
no name, so no guard that watches the name can see it. One
`AUDIO_JUDGE_CRITERIA.append(...)` in an example would put a drifted criterion
in front of the judge while every check still read the pristine file. A tuple
takes that away outright rather than enumerating the ways to spell it: pyright
rejects the mutation in CI, and the interpreter rejects it at runtime. The JS
copy is `as const` for the same reason. The examples pass `list(...)` to the
judge, which wants a `List[str]`, and that copy is theirs to keep.

WARNING: keep these as double-quoted string literals with no concatenation and
no f-strings. The parity test parses this tuple as JSON.
"""

from typing import Final

AUDIO_JUDGE_CRITERIA: Final[tuple[str, ...]] = (
    "The agent's response demonstrates it processed the SPECIFIC content of the audio — it addresses or attempts to answer the actual question that was asked in the audio. A generic acknowledgement that audio was received (e.g. 'I got your audio file', 'I heard your message') does NOT satisfy this criterion on its own",
    "The agent provides a coherent, on-topic response — NOT an error message, NOT a refusal, NOT a polite deflection or claim that it cannot process audio / non-text input (e.g. 'I'm sorry, I can't listen to audio files'), and NOT an unrelated reply",
    "The agent's response indicates it received input in a non-text format, or that the question came via audio rather than text (exact phrasing does not matter)",
)
