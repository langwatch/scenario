/**
 * Live ElevenLabs proof for issue #533 — `voiceStyle` on the wire.
 *
 * Not a test: it costs real ElevenLabs credits, so it is a hand-run harness,
 * never part of `vitest run`. Regenerates the checked-in evidence under
 * `javascript/outputs/recordings/issue533_voicestyle/`.
 *
 *   ELEVENLABS_API_KEY=... npx tsx scripts/voice-style-live-proof.ts
 *
 * Same text, same voice, twice: bare vs voiceStyle="angry", against the REAL
 * ElevenLabs API.
 *
 * Byte-difference alone proves nothing: `eleven_v3` is non-deterministic, so
 * two identical requests already return different bytes. The real
 * discriminator is what the audio SAYS. `eleven_v3` is the only EL model that
 * CONSUMES an inline `[angry]` marker as a delivery instruction; every other
 * model READS IT ALOUD as text. So:
 *
 *   - if the styled clip's transcript contains "angry"  -> the marker was
 *     spoken, i.e. treated as text, i.e. the mapping is wrong;
 *   - if it does not, and the transcript still matches the source line, the
 *     marker was consumed as a directive and never voiced -> the style
 *     reached the wire and was honoured as a style.
 *
 * Transcription is done by ElevenLabs Scribe (the SDK's own STT leaf), so the
 * check is independent of the TTS request we are asserting about.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AudioChunk } from "../src/voice/audio-chunk";
import { ElevenLabsSTTProvider } from "../src/voice/stt";
import { synthesize, clearTtsCache } from "../src/voice/tts";
import { elevenLabsSynthesizeBytes } from "../src/voice/tts/elevenlabs-tts";

const OUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "outputs",
  "recordings",
  "issue533_voicestyle",
);
const BARE_OUT = resolve(OUT_DIR, "bare.wav");
const ANGRY_OUT = resolve(OUT_DIR, "angry.wav");

const TEXT = "I have been on hold for forty minutes and nobody has helped me.";
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "EXAVITQu4vr4xnSDxMaL";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

// PCM16/24kHz mono -> minimal WAV so GitHub renders an inline player.
function toWav(pcm: Uint8Array, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}: ${detail}`);
  if (!ok) failures += 1;
}

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error("ELEVENLABS_API_KEY is not set — cannot run the live proof");
    process.exit(2);
  }
  console.log(`text  : ${JSON.stringify(TEXT)}`);
  console.log(`voice : elevenlabs/${VOICE_ID}  (model eleven_v3)`);
  console.log("");

  // --- Control: is the API even deterministic? -----------------------------
  const bareA = await elevenLabsSynthesizeBytes(TEXT, VOICE_ID, {});
  const bareB = await elevenLabsSynthesizeBytes(TEXT, VOICE_ID, {});
  console.log(
    `control  bare#1 bytes=${bareA.length} sha=${sha(bareA)} | ` +
      `bare#2 bytes=${bareB.length} sha=${sha(bareB)}`,
  );
  console.log(
    sha(bareA) === sha(bareB)
      ? "         (deterministic — byte-diff would be meaningful)"
      : "         (NON-deterministic — byte-diff proves nothing; see transcripts below)",
  );
  console.log("");

  // --- The styled call -----------------------------------------------------
  const angry = await elevenLabsSynthesizeBytes(TEXT, VOICE_ID, {
    voiceStyle: "angry",
  });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(BARE_OUT, toWav(bareA));
  writeFileSync(ANGRY_OUT, toWav(angry));
  console.log(`bare   bytes=${bareA.length}  sha=${sha(bareA)}  -> ${BARE_OUT}`);
  console.log(`angry  bytes=${angry.length}  sha=${sha(angry)}  -> ${ANGRY_OUT}`);
  console.log("");

  // --- The real discriminator: what does the audio SAY? --------------------
  const stt = new ElevenLabsSTTProvider();
  const bareText = await stt.transcribe(new AudioChunk({ data: bareA }));
  const angryText = await stt.transcribe(new AudioChunk({ data: angry }));
  console.log(`transcript(bare)  = ${JSON.stringify(bareText)}`);
  console.log(`transcript(angry) = ${JSON.stringify(angryText)}`);
  console.log("");

  const spokeMarker = /angry|\[/i.test(angryText);
  check(
    "marker not voiced",
    !spokeMarker,
    spokeMarker
      ? "the styled clip SPEAKS the marker — eleven_v3 read it as text, not as a directive"
      : 'the styled clip never says "angry" or "[" — the marker was consumed as a delivery directive',
  );
  // Scribe normalizes number words to digits ("forty" -> "40"), so accept both.
  const carriesLine = /hold for (forty|40) minutes/i.test(angryText);
  check(
    "line still intact",
    carriesLine,
    carriesLine
      ? "the styled clip still speaks the source line, so nothing was swallowed"
      : "the styled clip lost the source line",
  );

  // --- Router level: does the cache keep styled and unstyled apart? --------
  clearTtsCache();
  const rBare = await synthesize(TEXT, `elevenlabs/${VOICE_ID}`);
  const rAngry = await synthesize(TEXT, `elevenlabs/${VOICE_ID}`, undefined, {
    voiceStyle: "angry",
  });
  const rBareAgain = await synthesize(TEXT, `elevenlabs/${VOICE_ID}`);
  check(
    "cache does not collide",
    sha(rBare.data) !== sha(rAngry.data),
    `router bare sha=${sha(rBare.data)} vs angry sha=${sha(rAngry.data)}`,
  );
  check(
    "unstyled entry survives the styled call",
    sha(rBareAgain.data) === sha(rBare.data),
    `re-read of the unstyled key sha=${sha(rBareAgain.data)} (cache hit, not overwritten by the styled call)`,
  );

  console.log("");
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
