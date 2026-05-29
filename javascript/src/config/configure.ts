/**
 * Global scenario configuration entry point.
 *
 * Mirrors Python's `scenario.configure(...)` for **global execution
 * settings only** (PRD §4.7) — e.g. `audioPlayback` (stream conversation
 * audio to local speakers during a run). It does NOT configure providers.
 *
 * NOTE: `audioPlayback` is currently a stored-but-not-yet-consumed toggle.
 * Live local-speaker playback is a device-bound concern (the Python parity
 * runs it through `ffplay`/PyAudio); the TS runner does not read this setting
 * yet. The store + getter exist so the surface is stable for when the
 * playback sink lands — tracked at https://github.com/langwatch/scenario/issues/585.
 *
 * STT/TTS providers are per-run, not global: pass them via
 * `run({ voice: { stt, tts } })` (ADR-002). The invented
 * `configure({ stt })` knob — present in no other PR and not in Python —
 * has been removed; provider state no longer lives in a process-wide global.
 *
 * Global exec settings are stored in a module-level record read by the
 * runner. (These are genuinely global UX toggles, not per-run provider
 * state — the ADR-001 concurrency concern is about provider/model state
 * flowing into `call()`, which this is not.)
 */

/** Options accepted by {@link configure} — global execution settings. */
export interface ScenarioConfigureOptions {
  /**
   * Stream conversation audio to local speakers in real time during a run
   * (PRD §4.7). Off by default. Can also be set per-run via
   * `run({ voice: { audioPlayback: true } })` or `run({ audioPlayback })`.
   */
  audioPlayback?: boolean;
}

/** Current global execution settings (applied by {@link configure}). */
const globalSettings: ScenarioConfigureOptions = {};

/**
 * Apply global SDK execution configuration. Last write wins per field; only
 * provided fields are updated. Returns nothing (mirrors Python).
 */
export function configure(options: ScenarioConfigureOptions): void {
  if (options.audioPlayback !== undefined) {
    globalSettings.audioPlayback = options.audioPlayback;
  }
}

/**
 * Read the current global execution settings. Intended for the runner to read
 * once a live-playback sink is wired; not yet consumed (see {@link configure}).
 */
export function getGlobalSettings(): Readonly<ScenarioConfigureOptions> {
  return globalSettings;
}
