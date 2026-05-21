# elevenlabs_hosted recording fixture

Placeholder for the ElevenLabs hosted ConvAI demo recording.

`full.wav` lands here after a successful demo run with
`ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` set. The grinder that
opened this PR (PR7 of issue #372) did not have the keys available, so
the fixture is empty.

To populate:

```bash
ELEVENLABS_API_KEY=... \
ELEVENLABS_AGENT_ID=... \
  pnpm -C javascript/examples/vitest test tests/voice/elevenlabs-hosted.test.ts
```

The Python equivalent is `python/examples/voice/elevenlabs_hosted.py`.
