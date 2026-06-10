/**
 * Voice-specific script steps: sleep, silence, audio, dtmf, interrupt, and
 * background audio-effect helpers. These compose with the existing
 * `user` / `agent` / `judge` / `proceed` steps from `./index.ts` — no
 * separate paradigm.
 *
 * Python parity: `python/scenario/voice/script_steps.py`. The TypeScript
 * port keeps the same routing semantics: `audio()` rejects URL-like strings
 * to prevent ffmpeg from issuing outbound network requests on the caller's
 * behalf; `dtmf()` raises {@link UnsupportedCapabilityError} unless the
 * active adapter advertises `capabilities.dtmf`.
 *
 * Part of the TS voice parity slice (#372). The interruption / barge-in path
 * (`interrupt`, `proceed({ interruptions })`) is wired end-to-end through the
 * executor; the `backgroundNoise` mixing sink is still deferred (the step
 * records its config on the executor state for that future consumer).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import type { ModelMessage } from "ai";

import type {
  ScenarioExecutionLike,
  ScenarioExecutionStateLike,
  ScriptStep,
} from "../domain";
import {
  AudioChunk,
  silentChunk,
  UnsupportedCapabilityError,
  VoiceAgentAdapter,
} from "../voice";
import { resolveFfmpegPath } from "../voice/ffmpeg";
import type { InterruptionConfig } from "../voice/interruption";
import { sleep as sleepMs } from "../voice/utils";
import type { VoiceExecutorState } from "../voice/voice-executor-state";

const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//;
const AUDIO_EXTS = [".wav", ".mp3", ".ogg", ".flac"] as const;

/**
 * Minimal shape `voice-steps` reaches for on the executor. Structural so
 * the step DSL stays decoupled from the concrete executor class. Voice config
 * fields live on `VoiceExecutorState` — this interface merges them in via
 * intersection so callers see one typed surface.
 */
type VoiceAwareExecutor = ScenarioExecutionLike &
  Partial<VoiceExecutorState> & {
    /** Concrete executors expose the list of agents for adapter lookup. */
    readonly agents?: readonly { role?: unknown }[];
  };

/**
 * Pause the script for `seconds` wall-clock seconds.
 *
 * Does NOT transmit audio to the transport — this is purely a pause in the
 * script timeline. Use {@link silence} to send silent audio over the wire.
 */
export const sleep = (seconds: number): ScriptStep => {
  return async () => {
    await sleepMs(seconds * 1000);
  };
};

/**
 * Actively send `duration` seconds of silent PCM16 audio to the agent.
 *
 * Differs from {@link sleep}: the transport sees a connected-but-silent
 * user. Useful for testing how the agent handles silence (prompting,
 * escalation). Falls back to a pause when no voice adapter is configured.
 */
export const silence = (duration: number): ScriptStep => {
  return async (_state, executor) => {
    const adapter = voiceAdapter(executor);
    if (adapter === null) {
      await sleepMs(duration * 1000);
      return;
    }
    await adapter.sendAudio(silentChunk(duration));
  };
};

/**
 * Inject a pre-recorded audio file (WAV/MP3/OGG/FLAC) or raw bytes as the
 * user's next turn. Bypasses the user simulator and TTS entirely.
 *
 * Files are auto-converted to PCM16 @ 24kHz mono by shelling out to the
 * bundled `ffmpeg` binary (see {@link resolveFfmpegPath}; Python parity with
 * imageio-ffmpeg — no system ffmpeg required). Remote URL-like strings
 * (`http://`, `rtmp://`, etc.) are rejected so ffmpeg never issues outbound
 * network requests on the caller's behalf.
 */
export const audio = (pathOrBytes: string | Uint8Array): ScriptStep => {
  return async (_state, executor) => {
    const chunk = await loadAudioToChunk(pathOrBytes);
    const adapter = voiceAdapter(executor);
    if (adapter === null) {
      // No voice adapter under test — nothing to transmit to, so the decoded
      // chunk is a no-op for this step (the file still validated/decoded).
      return;
    }
    await adapter.sendAudio(chunk);
  };
};

/**
 * Emit DTMF tones (telephony-only). Raises {@link UnsupportedCapabilityError}
 * when the active adapter does not advertise `capabilities.dtmf`. The
 * adapter's `sendDtmf()` is invoked directly — adapters that claim the
 * capability without implementing the method get a loud failure from the
 * base-class default rather than a silent PCM fallback.
 */
export const dtmf = (tones: string): ScriptStep => {
  return async (_state, executor) => {
    const adapter = voiceAdapter(executor);
    const name = adapter ? adapter.constructor.name : "<no voice adapter>";
    if (adapter === null || !adapter.capabilities.dtmf) {
      throw new UnsupportedCapabilityError(name, "dtmf");
    }
    await adapter.sendDtmf(tones);
  };
};

export interface InterruptOptions {
  /** Optional content to send as the interruption (string text or audio bytes/path). */
  content?: string | Uint8Array;
  /**
   * TIME-based trigger (PRD §4.4 `interrupt(after=2.0, …)`): wait this many
   * seconds after the agent starts speaking before injecting the
   * interruption. Equivalent to `agent({wait:false}) + sleep(after) + user`.
   * Mutually exclusive with `afterWords` (which takes precedence if both set).
   */
  after?: number;
  /** Fire the interrupt only after the adapter's streaming transcript has emitted N words. */
  afterWords?: number;
  /** Bounded wait for the agent to start speaking before firing the interrupt. */
  waitForSpeechTimeout?: number;
}

/**
 * Declarative interruption step. Equivalent to:
 *
 *     agent({ wait: false }) -> (wait) -> user(content)
 *
 * Three trigger modes (PRD §4.4, layered):
 * - `after: <seconds>` — TIME-based. Let the agent speak for N seconds, then
 *   interrupt. The exact `interrupt(after=2.0, content)` form.
 * - `afterWords: N` — wait until the agent's streaming transcript has emitted
 *   N words. Requires `capabilities.streamingTranscripts`; raises
 *   {@link UnsupportedCapabilityError} otherwise.
 * - neither — a bounded wait for the agent to *start* speaking, then
 *   interrupt at the first chunk.
 *
 * The wait matters most on transports without a client-side cancel signal:
 * the interrupt must overlap real agent audio for the server's VAD to fire.
 * Without it, user TTS would finish generating in ~600ms while the model
 * still hasn't started speaking — the "interrupt" lands during silence and
 * transports nothing for the bot to barge against.
 *
 * `content` routing:
 * - `string` that does NOT end with an audio extension → user text (TTS).
 * - `string` ending with `.wav`/`.mp3`/`.ogg`/`.flac` → audio file.
 * - `Uint8Array` → raw audio bytes (routed through {@link audio}).
 */
export const interrupt = (options: InterruptOptions = {}): ScriptStep => {
  const { content, after, afterWords, waitForSpeechTimeout = 8.0 } = options;
  return async (state, executor) => {
    // Start the agent turn in the background, registering it as the pending
    // non-blocking turn so the user() below fires a mid-stream barge-in. Falls
    // back to fire-and-forget on executors without agentNonBlocking.
    const ex = executor as ScenarioExecutionLike & {
      agentNonBlocking?: (content?: string | ModelMessage) => void;
      interruptWaitForSpeechMs?: number;
    };
    if (typeof ex.agentNonBlocking === "function") {
      ex.agentNonBlocking();
    } else {
      void executor.agent().catch(() => {
        /* errors surface in executor state */
      });
    }

    // The text/empty content routes through executor.user() → fireUserInterrupt,
    // which does its OWN bounded wait-for-speech. Audio content goes straight to
    // adapter.sendAudio (audio()), bypassing that — so it must pre-wait here.
    const routesThroughUser = !isAudioContent(content);

    if (afterWords !== undefined) {
      await waitForStreamingWords(executor, afterWords, waitForSpeechTimeout);
    } else if (after !== undefined) {
      // TIME-based: let the agent speak (best-effort wait for it to start so
      // the sleep overlaps real audio), then sleep the requested seconds.
      await waitForAgentSpeaking(executor, waitForSpeechTimeout);
      await sleepMs(after * 1000);
    } else if (!routesThroughUser) {
      // Default mode, AUDIO content: this is the only wait before the barge-in
      // (audio() doesn't coordinate with the pending turn), so keep it.
      await waitForAgentSpeaking(executor, waitForSpeechTimeout);
    }
    // Default mode, TEXT content: no pre-wait — fireUserInterrupt does the
    // single wait-for-speech using the budget threaded just below, so the agent
    // isn't waited for twice (review m2: one timeout, not 8s here + 15s there).

    if (routesThroughUser) {
      // Thread THIS step's wait budget into the barge-in so the executor's
      // wait-for-speech uses the same knob as the step.
      ex.interruptWaitForSpeechMs = waitForSpeechTimeout * 1000;
      if (content !== undefined && content !== "") {
        await executor.user(content as string);
      } else {
        await executor.user();
      }
    } else {
      await audio(content as string | Uint8Array)(state, executor);
    }
  };
};

/** Per-step voice overrides for {@link user} (PRD §4.2). */
export interface VoiceUserOptions {
  /**
   * Apply a voice style (e.g. `"angry"`) to ONLY this turn's TTS. Reverts to
   * the simulator's default voice on subsequent turns. (PRD §4.2 L290.)
   */
  voiceStyle?: string;
  /**
   * Audio effects applied to ONLY this turn's synthesized audio, overriding
   * the simulator's default effects for the turn. (PRD §4.2 L293.)
   */
  audioEffects?: Array<(audio: Uint8Array) => Uint8Array>;
}

/**
 * The duck-typed slice of the concrete user simulator a per-step override
 * touches. Detected structurally so the script step stays decoupled from the
 * concrete `UserSimulatorAgent` class.
 */
interface OneShotOverridable {
  setOneShotOverride(opts: {
    voiceStyle?: string;
    audioEffects?: Array<(audio: Uint8Array) => Uint8Array>;
  }): () => void;
}

function isOneShotOverridable(agent: unknown): agent is OneShotOverridable {
  return (
    typeof agent === "object" &&
    agent !== null &&
    typeof (agent as { setOneShotOverride?: unknown }).setOneShotOverride ===
      "function"
  );
}

/**
 * Run `body` with a one-shot voice-style / audio-effects override installed on
 * the scenario's user-simulator agent, restoring the prior state afterwards
 * (PRD §4.2 per-step overrides). When no override is requested, or no
 * overridable user simulator is present, `body` runs untouched.
 *
 * Exposed so the canonical `user()` script step (script/index.ts) can apply
 * `{ voiceStyle, audioEffects }` for a single turn without coupling to the
 * concrete simulator class.
 */
export async function withUserStepOverride(
  executor: ScenarioExecutionLike,
  options: VoiceUserOptions | undefined,
  body: () => Promise<void>,
): Promise<void> {
  if (!options || (options.voiceStyle === undefined && options.audioEffects === undefined)) {
    await body();
    return;
  }
  const sim = findUserSimulator(executor);
  if (!sim) {
    // No overridable simulator — the override is a no-op (e.g. a custom
    // user agent or a text-only run). Run the turn unchanged.
    await body();
    return;
  }
  const restore = sim.setOneShotOverride({
    voiceStyle: options.voiceStyle,
    audioEffects: options.audioEffects,
  });
  try {
    await body();
  } finally {
    restore();
  }
}

function findUserSimulator(
  executor: ScenarioExecutionLike,
): OneShotOverridable | null {
  const agents = (executor as VoiceAwareExecutor).agents ?? [];
  for (const agent of agents) {
    if (isOneShotOverridable(agent)) return agent;
  }
  return null;
}

export interface VoiceAgentOptions {
  /** Optional message content; passed through to `executor.agent()`. */
  content?: string | ModelMessage;
  /** When `false`, fire the agent turn without awaiting it. */
  wait?: boolean;
}

/**
 * Engine behind the unified {@link import("./index.js").agent} step (and its
 * {@link import("./index.js").voiceAgent} alias). When `wait: false`, fires the
 * agent turn in the background and returns control immediately — the agent's
 * audio continues streaming during subsequent script steps (e.g. {@link sleep},
 * {@link silence}). With `wait` unset/true it awaits the turn, so the same
 * function serves both the blocking text form and the non-blocking voice form.
 *
 * Not exported on the public `scenario` surface directly; `script/index.ts`
 * wraps it as `agent(...)` / `voiceAgent(...)`.
 */
export const voiceAgentStep = (options: VoiceAgentOptions = {}): ScriptStep => {
  return (_state, executor) => {
    if (options.wait === false) {
      // Non-blocking: register the in-flight turn on the executor so a
      // subsequent user() lands as a mid-stream barge-in (interruption). Falls
      // back to fire-and-forget when the executor predates agentNonBlocking.
      const ex = executor as ScenarioExecutionLike & {
        agentNonBlocking?: (content?: string | ModelMessage) => void;
      };
      if (typeof ex.agentNonBlocking === "function") {
        ex.agentNonBlocking(options.content);
        return;
      }
      void executor.agent(options.content).catch(() => {
        /* errors surface in executor state */
      });
      return;
    }
    return executor.agent(options.content);
  };
};

export interface VoiceProceedOptions {
  /** Number of turns to proceed automatically. */
  turns?: number;
  /** Callback fired at the end of each turn. */
  onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>;
  /** Callback fired after each agent interaction. */
  onStep?: (state: ScenarioExecutionStateLike) => void | Promise<void>;
  /** Inject random interruptions during the proceed loop. */
  interruptions?: InterruptionConfig;
}

/**
 * Voice variant of {@link import("./index.js").proceed}. Adds the
 * `interruptions` option for injecting random user interruptions during
 * the proceed loop. This script step records the config on the executor
 * state; the loop consumes it via `maybeScheduleInterruptedAgentTurn`
 * (Gap #8, voice path) which dispatches the agent non-blocking PRE-step so
 * the next user-sim turn fires a real mid-stream barge-in. Text-only runs
 * fall back to the post-step `maybeInjectInterruption`.
 */
export const proceed = (options: VoiceProceedOptions = {}): ScriptStep => {
  return async (_state, executor) => {
    const vex = executor as VoiceAwareExecutor;
    const prev = vex.voiceInterruptions;
    if (options.interruptions !== undefined) {
      // Write through the typed VoiceExecutorState surface (Decision 1(b)
      // — see voice-executor-state.ts) rather than reaching for a private
      // attribute. The executor reads this inside the proceed loop and
      // injects interruptions per the configured probability/strategy.
      vex.voiceInterruptions = options.interruptions;
    }
    try {
      await executor.proceed(options.turns, options.onTurn, options.onStep);
    } finally {
      // Restore prior value so a subsequent voiceProceed (or plain proceed)
      // does not inherit this call's interruption config (P2 config-leak fix).
      vex.voiceInterruptions = prev;
    }
  };
};

/**
 * Configure background ambient audio for subsequent user-simulator turns.
 *
 * PR5 ships the script-step contract surface; the actual mixing happens in
 * the audio-effects subsystem (deferred). Calling this returns a no-op
 * ScriptStep that records the desired ambience on the executor state so
 * downstream PRs can pick it up.
 */
export const backgroundNoise = (
  source: string,
  volume = 0.3,
): ScriptStep => {
  if (volume < 0 || volume > 1) {
    throw new RangeError(
      `backgroundNoise(volume=${volume}) out of range — expected [0, 1].`,
    );
  }
  return (_state, executor) => {
    // Write through the typed VoiceExecutorState surface — the audio-effects
    // subsystem (PR6+) reads `voiceBackgroundNoise` when mixing simulator
    // turns.
    (executor as VoiceAwareExecutor).voiceBackgroundNoise = { source, volume };
  };
};

// ---------------------------------------------------------------- helpers

function isAudioContent(content: InterruptOptions["content"]): boolean {
  if (content instanceof Uint8Array) return true;
  if (typeof content === "string") {
    const lower = content.toLowerCase();
    return AUDIO_EXTS.some((ext) => lower.endsWith(ext));
  }
  return false;
}

function voiceAdapter(
  executor: ScenarioExecutionLike,
): VoiceAgentAdapter | null {
  const ex = executor as VoiceAwareExecutor;
  const agents = ex.agents ?? [];
  for (const agent of agents) {
    if (agent instanceof VoiceAgentAdapter) return agent;
  }
  return null;
}

async function waitForAgentSpeaking(
  executor: ScenarioExecutionLike,
  timeoutSeconds: number,
): Promise<void> {
  const adapter = voiceAdapter(executor);
  if (adapter === null) return;
  const speaking = adapter.agentSpeakingEvent;
  if (!speaking || speaking.isSet()) return;
  await Promise.race([speaking.wait(), sleepMs(timeoutSeconds * 1000)]);
}

async function waitForStreamingWords(
  executor: ScenarioExecutionLike,
  targetWords: number,
  timeoutSeconds: number,
): Promise<void> {
  const adapter = voiceAdapter(executor);
  const name = adapter ? adapter.constructor.name : "<no voice adapter>";
  if (adapter === null || !adapter.capabilities.streamingTranscripts) {
    throw new UnsupportedCapabilityError(
      name,
      "streaming_transcripts",
      "interrupt({ afterWords: N }) needs incremental transcripts. " +
        "Use interrupt({ content }) without afterWords on this adapter — " +
        "the executor fires barge-in at the agent's first audio chunk.",
    );
  }
  // Bounded polling — a wedged adapter that never advances its transcript
  // would otherwise lock the script forever. Mirrors waitForAgentSpeaking.
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const transcript = adapter.streamingTranscript ?? "";
    if (transcript.trim().split(/\s+/).filter(Boolean).length >= targetWords) {
      return;
    }
    await sleepMs(50);
  }
}


/**
 * Load an audio file or raw bytes and normalise to PCM16 @ 24kHz mono.
 *
 * Rejects URL-like strings (`http://`, `rtmp://`, etc.) so ffmpeg never
 * makes outbound network requests on the caller's behalf. Defence in depth
 * also applied via `-protocol_whitelist file,pipe` on the bytes path.
 */
async function loadAudioToChunk(
  pathOrBytes: string | Uint8Array,
): Promise<AudioChunk> {
  let sourceArgs: string[];
  let stdinInput: Buffer | undefined;

  if (pathOrBytes instanceof Uint8Array) {
    sourceArgs = ["-i", "pipe:0"];
    stdinInput = Buffer.from(pathOrBytes);
  } else {
    const pathStr = String(pathOrBytes);
    if (URL_LIKE.test(pathStr)) {
      throw new Error(
        `audio() refuses URL-like input ${JSON.stringify(pathStr)}. ` +
          "Pass a filesystem path (no scheme) or pre-load the audio as raw " +
          "bytes — the SDK never issues outbound requests for audio assets " +
          "on the caller's behalf, even for file:// URIs.",
      );
    }
    const resolved = resolvePath(pathStr);
    if (!existsSync(resolved)) {
      // Read so we surface the platform's standard ENOENT error message.
      await readFile(resolved);
    }
    sourceArgs = ["-i", resolved];
  }

  const result = spawnSync(
    resolveFfmpegPath(),
    [
      "-protocol_whitelist",
      "file,pipe",
      "-loglevel",
      "error",
      "-y",
      ...sourceArgs,
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      "24000",
      "pipe:1",
    ],
    { input: stdinInput },
  );
  if (result.error) {
    throw new Error(
      `ffmpeg subprocess failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed to decode audio: ${result.stderr?.toString("utf8") ?? ""}`,
    );
  }
  return new AudioChunk({ data: new Uint8Array(result.stdout) });
}
