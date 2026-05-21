/**
 * Global scenario configuration entry point.
 *
 * Mirrors Python's `scenario.configure(...)`. PR2 of #372 introduces the
 * `stt` knob; later PRs will extend this with additional voice-subsystem
 * configuration (TTS effects pipeline, recording defaults, etc.) at the
 * same surface.
 */
import { type STTProvider, setSttProvider } from "../voice/stt";

/** Options accepted by {@link configure}. */
export interface ScenarioConfigureOptions {
  /**
   * Install a custom STT provider, or pass `null` to clear the configured
   * provider — downstream callers (e.g. `transcribeSegments`) treat the
   * cleared state as "best-effort STT not available" and skip without
   * raising.
   */
  stt?: STTProvider | null;
}

/**
 * Apply global SDK configuration. Currently scoped to the voice subsystem
 * (STT provider); future PRs may add more knobs at this surface.
 */
export function configure(options: ScenarioConfigureOptions): void {
  if (options.stt !== undefined) {
    setSttProvider(options.stt);
  }
}
