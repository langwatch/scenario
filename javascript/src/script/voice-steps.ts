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
 * PR5 of the TS voice parity slice (#372) — pure SDK orchestration. The
 * underlying executor/adapter wiring lands in PR6+.
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
import type { InterruptionConfig } from "../voice/interruption";

const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//;
const AUDIO_EXTS = [".wav", ".mp3", ".ogg", ".flac"] as const;

/**
 * Minimal shape `voice-steps` reaches for on the executor. We use a
 * structural type instead of importing the concrete executor class so the
 * step DSL stays decoupled from runtime wiring (PR6+).
 */
interface VoiceAwareExecutor extends ScenarioExecutionLike {
  /** Concrete executors expose the list of agents for adapter lookup. */
  readonly agents?: readonly { role?: unknown }[];
}

/**
 * Pause the script for `seconds` wall-clock seconds.
 *
 * Does NOT transmit audio to the transport — this is purely a pause in the
 * script timeline. Use {@link silence} to send silent audio over the wire.
 */
export const sleep = (seconds: number): ScriptStep => {
  return async () => {
    await delay(seconds * 1000);
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
      await delay(duration * 1000);
      return;
    }
    await adapter.sendAudio(silentChunk(duration));
  };
};

/**
 * Inject a pre-recorded audio file (WAV/MP3/OGG/FLAC) or raw bytes as the
 * user's next turn. Bypasses the user simulator and TTS entirely.
 *
 * Files are auto-converted to PCM16 @ 24kHz mono by shelling out to
 * `ffmpeg` (must be on PATH). Remote URL-like strings (`http://`,
 * `rtmp://`, etc.) are rejected so ffmpeg never issues outbound network
 * requests on the caller's behalf.
 */
export const audio = (pathOrBytes: string | Uint8Array): ScriptStep => {
  return async (_state, executor) => {
    const chunk = await loadAudioToChunk(pathOrBytes);
    const adapter = voiceAdapter(executor);
    if (adapter === null) {
      // No voice adapter — leave the chunk dangling. PR6+ will wire this
      // into the message history when the executor learns audio messages.
      return;
    }
    await adapter.sendAudio(chunk);
  };
};

/**
 * Emit DTMF tones (telephony-only). Raises {@link UnsupportedCapabilityError}
 * when the active adapter does not advertise `capabilities.dtmf`.
 */
export const dtmf = (tones: string): ScriptStep => {
  return async (_state, executor) => {
    const adapter = voiceAdapter(executor);
    const name = adapter ? adapter.constructor.name : "<no voice adapter>";
    if (adapter === null || !adapter.capabilities.dtmf) {
      throw new UnsupportedCapabilityError(name, "dtmf", "Use a telephony adapter such as TwilioAgentAdapter.");
    }
    const sendDtmf = (adapter as unknown as { sendDtmf?: (tones: string) => Promise<void> }).sendDtmf;
    if (typeof sendDtmf === "function") {
      await sendDtmf.call(adapter, tones);
      return;
    }
    // Fallback: synth DTMF as PCM16 and send via sendAudio.
    await adapter.sendAudio(dtmfToPcm(tones));
  };
};

export interface InterruptOptions {
  /** Optional content to send as the interruption (string text or audio bytes/path). */
  content?: string | Uint8Array;
  /** Fire the interrupt only after the adapter's streaming transcript has emitted N words. */
  afterWords?: number;
  /** Bounded wait for the agent to start speaking before firing the interrupt. */
  waitForSpeechTimeout?: number;
}

/**
 * Declarative interruption step. Equivalent to:
 *
 *     agent({ wait: false }) -> (bounded wait) -> user(content)
 *
 * The bounded wait matters most on transports without a client-side cancel
 * signal: the interrupt must overlap real agent audio for the server's VAD
 * to fire. Without it, user TTS would finish generating in ~600ms while
 * the model still hasn't started speaking — the "interrupt" lands during
 * silence and transports nothing for the bot to barge against.
 *
 * `afterWords`: instead of interrupting at first chunk, wait until the
 * agent's streaming transcript has emitted N words. Requires
 * `capabilities.streamingTranscripts`; raises {@link UnsupportedCapabilityError}
 * otherwise.
 *
 * `content` routing:
 * - `string` that does NOT end with an audio extension → user text (TTS).
 * - `string` ending with `.wav`/`.mp3`/`.ogg`/`.flac` → audio file.
 * - `Uint8Array` → raw audio bytes (routed through {@link audio}).
 */
export const interrupt = (options: InterruptOptions = {}): ScriptStep => {
  const { content, afterWords, waitForSpeechTimeout = 8.0 } = options;
  return async (state, executor) => {
    // Start the agent turn in the background. Errors surface on the
    // executor state; the script step intentionally does not await.
    void executor.agent().catch(() => {
      /* errors surface in executor state */
    });

    if (afterWords !== undefined) {
      await waitForStreamingWords(executor, afterWords);
    } else {
      await waitForAgentSpeaking(executor, waitForSpeechTimeout);
    }

    if (isAudioContent(content)) {
      await audio(content as string | Uint8Array)(state, executor);
    } else if (content !== undefined && content !== "") {
      await executor.user(content as string);
    } else {
      await executor.user();
    }
  };
};

export interface VoiceAgentOptions {
  /** Optional message content; passed through to `executor.agent()`. */
  content?: string | ModelMessage;
  /** When `false`, fire the agent turn without awaiting it. */
  wait?: boolean;
}

/**
 * Voice variant of {@link import("./index.js").agent}. When `wait: false`,
 * fires the agent turn in the background and returns control immediately —
 * the agent's audio continues streaming during subsequent script steps
 * (e.g. {@link sleep}, {@link silence}).
 */
export const agent = (options: VoiceAgentOptions = {}): ScriptStep => {
  return (_state, executor) => {
    const promise = executor.agent(options.content);
    if (options.wait === false) {
      void promise.catch(() => {
        /* errors surface in executor state */
      });
      return;
    }
    return promise;
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
 * the proceed loop. The interruption-injection wiring lives on the
 * executor (PR6+); this script step records the config on the executor
 * state where downstream PRs pick it up.
 */
export const proceed = (options: VoiceProceedOptions = {}): ScriptStep => {
  return async (_state, executor) => {
    const ex = executor as VoiceAwareExecutor & {
      _voiceInterruptions?: InterruptionConfig;
    };
    if (options.interruptions !== undefined) {
      // Stash on the executor for downstream wiring. PR6+ will read this
      // from inside the proceed loop and inject interruptions.
      ex._voiceInterruptions = options.interruptions;
    }
    await executor.proceed(options.turns, options.onTurn, options.onStep);
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
    const ex = executor as VoiceAwareExecutor & {
      _voiceBackgroundNoise?: { source: string; volume: number };
    };
    ex._voiceBackgroundNoise = { source, volume };
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
  const speaking = (adapter as unknown as {
    _agentSpeakingEvent?: { wait: () => Promise<void>; isSet: () => boolean };
  })._agentSpeakingEvent;
  if (!speaking || speaking.isSet()) return;
  await Promise.race([
    speaking.wait(),
    delay(timeoutSeconds * 1000),
  ]);
}

async function waitForStreamingWords(
  executor: ScenarioExecutionLike,
  targetWords: number,
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
  for (;;) {
    const transcript =
      (adapter as unknown as { streamingTranscript?: string }).streamingTranscript ?? "";
    if (transcript.trim().split(/\s+/).filter(Boolean).length >= targetWords) {
      return;
    }
    await delay(50);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        `audio() refuses URL-like input ${JSON.stringify(pathStr)}; ` +
          "download the asset locally and pass a path instead.",
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
    "ffmpeg",
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
      `ffmpeg subprocess failed (is ffmpeg installed and on PATH?): ` +
        `${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed to decode audio: ${result.stderr?.toString("utf8") ?? ""}`,
    );
  }
  return new AudioChunk({ data: new Uint8Array(result.stdout) });
}

// ------------------------- DTMF tone fallback (kept tiny on purpose) ----

const DTMF_ROW_HZ: Record<string, number> = {
  "1": 697,
  "2": 697,
  "3": 697,
  "4": 770,
  "5": 770,
  "6": 770,
  "7": 852,
  "8": 852,
  "9": 852,
  "*": 941,
  "0": 941,
  "#": 941,
};
const DTMF_COL_HZ: Record<string, number> = {
  "1": 1209,
  "2": 1336,
  "3": 1477,
  "4": 1209,
  "5": 1336,
  "6": 1477,
  "7": 1209,
  "8": 1336,
  "9": 1477,
  "*": 1209,
  "0": 1336,
  "#": 1477,
};

function dtmfToPcm(
  tones: string,
  sr = 24000,
  durSec = 0.1,
  gapSec = 0.05,
): AudioChunk {
  const nTone = Math.floor(sr * durSec);
  const nGap = Math.floor(sr * gapSec);
  const parts: Int16Array[] = [];
  for (const ch of tones) {
    const row = DTMF_ROW_HZ[ch];
    const col = DTMF_COL_HZ[ch];
    if (row === undefined || col === undefined) continue;
    const samples = new Int16Array(nTone);
    for (let i = 0; i < nTone; i++) {
      const t = i / sr;
      const wave =
        0.5 *
        (Math.sin(2 * Math.PI * row * t) + Math.sin(2 * Math.PI * col * t));
      samples[i] = Math.max(-32768, Math.min(32767, Math.round(wave * 32767)));
    }
    parts.push(samples);
    parts.push(new Int16Array(nGap));
  }
  if (parts.length === 0) return new AudioChunk({ data: new Uint8Array(0) });
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return new AudioChunk({ data: new Uint8Array(out.buffer) });
}
