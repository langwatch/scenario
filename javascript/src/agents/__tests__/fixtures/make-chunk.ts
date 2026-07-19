import { AudioChunk } from "../../../voice/audio-chunk";

/**
 * Minimal 4-byte {@link AudioChunk} fixture, optionally carrying a transcript.
 * Shared across the voice agent tests (user simulator, assistant role, judge).
 */
export function makeChunk(transcript?: string): AudioChunk {
  return new AudioChunk({ data: new Uint8Array(4), transcript });
}
