/**
 * Minimal RIFF/WAV encoder for the STT upload edge.
 *
 * Both STT providers (OpenAI, ElevenLabs) accept a WAV container, not raw
 * PCM16 — so the canonical {@link AudioChunk} bytes are wrapped here before
 * upload. This is an *adapter-edge* conversion, distinct from the in-message
 * audio format (which is the AI-SDK `file` part with raw `audio/pcm16`; see
 * `voice/messages.ts`). De-dupes the two private `pcm16ToWav` copies that
 * the flat `stt.ts` carried (one per provider).
 */
import {
  PCM16_CHANNELS,
  PCM16_SAMPLE_RATE,
  PCM16_SAMPLE_WIDTH_BYTES,
} from "../audio-chunk";

/** Wrap raw PCM16/24 kHz mono bytes in a minimal WAV (RIFF) container. */
export function pcm16ToWav(pcm: Uint8Array): Uint8Array {
  const dataLen = pcm.length;
  const byteRate =
    PCM16_SAMPLE_RATE * PCM16_CHANNELS * PCM16_SAMPLE_WIDTH_BYTES;
  const blockAlign = PCM16_CHANNELS * PCM16_SAMPLE_WIDTH_BYTES;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, PCM16_CHANNELS, true);
  view.setUint32(24, PCM16_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, PCM16_SAMPLE_WIDTH_BYTES * 8, true);
  writeAscii(36, "data");
  view.setUint32(40, dataLen, true);

  const out = new Uint8Array(44 + dataLen);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}
