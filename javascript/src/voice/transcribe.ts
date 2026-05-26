/**
 * Post-hoc STT over a {@link VoiceRecording} — fills `transcript` on segments
 * that don't already have one.
 *
 * Python parity: `python/scenario/voice/_transcribe.py`. Mutates segments in
 * place rather than returning a new recording — keeps the manifest, the
 * executor's voice recording, and any user-held reference in sync without
 * churn.
 *
 * Failure mode: if `provider: null` is passed (no STT provider), log a
 * warning and return without raising. Per-segment failures are caught,
 * logged, and leave `transcript` undefined — callers (judge, save flows)
 * treat null transcripts as "best-effort not available" and proceed.
 *
 * (Bound to spec `missing STT provider degrades gracefully` and
 * `transcribe_segments fills missing transcripts in place`.)
 */
import { AudioChunk } from "./audio-chunk";
import type { AudioSegment, VoiceRecording } from "./recording.types";
import { type STTProvider, OpenAISTTProvider } from "./stt";

/** Options for {@link transcribeSegments}. */
export interface TranscribeSegmentsOptions {
  /**
   * The STT provider for this call. Omit to use the per-run default
   * (`new OpenAISTTProvider()` — a pure default, not shared state). Pass
   * `null` to declare "no provider" — segments are left untranscribed and a
   * warning is logged (graceful degrade). In a scenario run the resolved
   * `cfg.voice.stt` provider (`ResolvedVoiceConfig`) is threaded in here.
   */
  provider?: STTProvider | null;
  /**
   * When true (default), skip segments whose transcript is already set.
   * When false, re-transcribe everything (e.g. to overwrite adapter-side
   * STT with a different provider).
   */
  onlyMissing?: boolean;
  /** Sink for warnings — defaults to {@link console.warn}. */
  logWarn?: (message: string) => void;
}

/**
 * Run STT over `recording.segments`, mutating `transcript` in place.
 *
 * Concurrency: transcribes segments concurrently with `Promise.all`. Each
 * segment's STT call is independent. Empty-data segments are skipped.
 *
 * Errors are caught per-segment and logged as warnings; never raised. The
 * transcript stays undefined on failed segments and the caller sees partial
 * coverage.
 */
export async function transcribeSegments(
  recording: VoiceRecording,
  options: TranscribeSegmentsOptions = {},
): Promise<void> {
  if (!recording.segments?.length) return;

  const warn = options.logWarn ?? ((m: string) => console.warn(m));
  // No global: default to a per-run OpenAI provider when unspecified;
  // explicit `null` means "no provider" → graceful degrade.
  const provider =
    options.provider !== undefined
      ? options.provider
      : new OpenAISTTProvider();
  if (!provider) {
    warn(
      "scenario.voice.transcribe: no STT provider configured; agent " +
        "transcripts will remain null. Pass a provider, or set one per-run " +
        "via run({ voice: { stt: ... } }), to enable.",
    );
    return;
  }

  const onlyMissing = options.onlyMissing ?? true;
  const targets = recording.segments.filter(
    (s) => s.audio.length > 0 && (!onlyMissing || s.transcript === undefined),
  );
  if (!targets.length) return;

  await Promise.all(targets.map((segment) => transcribeOne(provider, segment, warn)));
}

async function transcribeOne(
  provider: STTProvider,
  segment: AudioSegment,
  warn: (message: string) => void,
): Promise<void> {
  try {
    const text = await provider.transcribe(new AudioChunk({ data: segment.audio }));
    segment.transcript = text || undefined;
  } catch (e) {
    warn(
      `scenario.voice.transcribe: STT failed for ${segment.speaker} segment at ` +
        `${segment.startTime.toFixed(2)}s: ${(e as Error).message ?? e}`,
    );
  }
}
