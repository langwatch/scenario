# #747 — EL audioQueue turn-boundary fix: before/after voice-sim proof

Live hosted-ElevenLabs runs of the same scenario (a `firstMessageOverride` greeting
whose TTS runs ~66s, well past the 30s `responseMaxDuration`; script
`[agent(), proceed(4), judge()]`; independent Whisper cross-check per agent segment;
`gpt-5-mini` judge). BEFORE runs the published pre-fix `@langwatch/scenario@0.5.1`;
AFTER runs this branch's build.

Play the three clips to hear the fix:

| file | run | what you hear |
|------|-----|---------------|
| `before-greeting-chopped-at-30s.wav` | BEFORE (pre-fix 0.5.1) | the greeting, **cut off at exactly 30.0s** (the `responseMaxDuration` cap) mid-sentence |
| `before-fake-remainder-turn.wav` | BEFORE (pre-fix 0.5.1) | the greeting's **second half** ("If you're calling about a card…") surfacing as a **fake 35.3s agent turn** that ignores the user's balance question — the split-utterance bleed. Judge **FAILS** ("repeats the greeting/intro… prevents the conversation from moving forward"). |
| `after-whole-greeting-66s.wav` | AFTER (this branch, HEAD `9d8bb69`) | the **whole 66s greeting as one segment**, delivered once; the next agent turn is an on-topic reply. Judge **PASSES** ("did not repeat or restate the long greeting… no looping"). |

Whisper cross-check: each AFTER agent segment's audio matches its own transcript
(token Jaccard ≥ 0.96), and no AFTER segment repeats a prior segment's text — i.e.
one agent utterance = one agent message, which is exactly what #747 asked for.
