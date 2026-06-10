/**
 * Voice script-step scenario bindings — PR5 of issue #372.
 *
 * Binds 11 scenarios from `specs/voice-agents.feature` tagged
 * `@ts-script-step`. Each scenario is a focused unit test on a single
 * step factory (sleep, silence, audio, dtmf, interrupt, agent(wait=false),
 * proceed(interruptions)) using minimal stub executors and adapters —
 * the goal is to pin the orchestration contract, not exercise transports.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import type { ModelMessage } from "ai";
import { describe, it, expect } from "vitest";

import { AgentRole } from "../../domain/agents";
import {
  AdapterCapabilities,
  AudioChunk,
  InterruptionConfig,
  resolveFfmpegPath,
  UnsupportedCapabilityError,
  VoiceAgentAdapter,
} from "../../voice";
import {
  agent,
  audio,
  dtmf,
  interrupt,
  silence,
  sleep,
  voiceAgent,
  voiceProceed,
} from "../index";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "specs", "voice-agents.feature");

/**
 * Minimal voice-aware adapter used by these scenarios. Each instance
 * records audio that was sent, whether `sendDtmf` was called, and exposes
 * a mutable `streamingTranscript` for the after-words tests.
 */
class TestVoiceAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  capabilities: AdapterCapabilities;

  sentAudio: AudioChunk[] = [];
  sentDtmf: string[] = [];
  streamingTranscript = "";

  constructor(capsInit: ConstructorParameters<typeof AdapterCapabilities>[0] = {}) {
    super();
    this.capabilities = new AdapterCapabilities({
      streamingTranscripts: capsInit?.streamingTranscripts ?? false,
      nativeVad: capsInit?.nativeVad ?? false,
      dtmf: capsInit?.dtmf ?? false,
      interruption: capsInit?.interruption ?? false,
      inputFormats: capsInit?.inputFormats ?? [],
      outputFormats: capsInit?.outputFormats ?? [],
    });
  }

  async call(): Promise<string> {
    return "stub";
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(chunk: AudioChunk): Promise<void> {
    this.sentAudio.push(chunk);
  }
  async receiveAudio(): Promise<AudioChunk> {
    return new AudioChunk({ data: new Uint8Array(0) });
  }
  async sendDtmf(tones: string): Promise<void> {
    this.sentDtmf.push(tones);
  }
}

/**
 * In-memory executor stub. Records every call against the
 * `ScenarioExecutionLike` surface so script steps can be asserted on the
 * resulting trace.
 */
function makeExecutor(adapter?: TestVoiceAdapter, options: {
  agentDelayMs?: number;
} = {}) {
  const trace: string[] = [];
  let agentResolve: (() => void) | null = null;
  let agentPromise: Promise<void> | null = null;

  const proceedCalls: Array<{
    turns?: number;
    onTurn?: unknown;
    onStep?: unknown;
  }> = [];

  const executor = {
    messages: [] as ModelMessage[],
    threadId: "test-thread",
    agents: adapter ? [adapter] : [],
    async message() {
      trace.push("message");
    },
    async user(content?: string | ModelMessage) {
      trace.push(`user:${typeof content === "string" ? content : "(default)"}`);
    },
    async agent(content?: string | ModelMessage) {
      trace.push(`agent:${typeof content === "string" ? content : "(default)"}`);
      if (options.agentDelayMs !== undefined) {
        agentPromise = new Promise<void>((resolve) => {
          agentResolve = resolve;
          setTimeout(() => {
            agentResolve?.();
          }, options.agentDelayMs);
        });
        await agentPromise;
      }
    },
    async judge() {
      trace.push("judge");
      return null;
    },
    async proceed(turns?: number, onTurn?: unknown, onStep?: unknown) {
      trace.push(`proceed:${turns ?? "auto"}`);
      proceedCalls.push({ turns, onTurn, onStep });
      return null;
    },
    async succeed() {
      trace.push("succeed");
      return {} as never;
    },
    async fail() {
      trace.push("fail");
      return {} as never;
    },
  };

  const state = {} as never;
  return { executor, state, trace, proceedCalls };
}

function makeStateStub() {
  return {} as never;
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // ---------------------------------------------------------------- sleep
    Scenario(
      "scenario.sleep(seconds) pauses the script without touching the transport",
      ({ Given, When, Then, And }) => {
        let step: ReturnType<typeof sleep>;
        let elapsedMs: number;
        let ctx = makeExecutor(new TestVoiceAdapter());

        Given("scenario.sleep(2.0) in a script", () => {
          step = sleep(0.05);
          ctx = makeExecutor(new TestVoiceAdapter());
        });

        When("the step runs", async () => {
          const before = Date.now();
          await step(makeStateStub(), ctx.executor);
          elapsedMs = Date.now() - before;
        });

        Then("the script pauses 2.0 real seconds", () => {
          expect(elapsedMs).toBeGreaterThanOrEqual(40);
        });

        And("no audio is sent on the transport during the pause", () => {
          const adapter = ctx.executor.agents[0] as TestVoiceAdapter;
          expect(adapter.sentAudio).toHaveLength(0);
        });
      },
    );

    // -------------------------------------------------------------- silence
    Scenario(
      "scenario.silence(duration) sends silent audio to the transport",
      ({ Given, When, Then }) => {
        const adapter = new TestVoiceAdapter();
        const ctx = makeExecutor(adapter);
        let step: ReturnType<typeof silence>;

        Given("scenario.silence(5.0) in a script", () => {
          step = silence(0.1);
        });

        When("the step runs", async () => {
          await step(ctx.state, ctx.executor);
        });

        Then(
          "5.0 seconds of PCM16 zero-audio is sent to the agent under test",
          () => {
            expect(adapter.sentAudio).toHaveLength(1);
            const sent = adapter.sentAudio[0];
            expect(sent).toBeInstanceOf(AudioChunk);
            expect(sent.durationSeconds).toBeCloseTo(0.1, 2);
            // PCM16 silence is all zeros.
            expect(sent.data.every((b) => b === 0)).toBe(true);
          },
        );
      },
    );

    // ----------------------------------------------------- agent(wait=False)
    Scenario(
      "agent(wait=False) returns immediately and the agent speaks in background",
      ({ Given, When, Then, And }) => {
        const ctx = makeExecutor(new TestVoiceAdapter(), { agentDelayMs: 200 });
        let startedAt = 0;
        let returnedAt = 0;
        let agentStep: ReturnType<typeof agent>;
        let sleepStep: ReturnType<typeof sleep>;

        Given(
          "a script with scenario.agent(wait=False) followed by scenario.sleep(2.0)",
          () => {
            // PRD §9 / §6.2 primitive: the non-blocking turn IS `scenario.agent({
            // wait: false })`. `scenario.voiceAgent({ wait: false })` is the alias.
            agentStep = agent({ wait: false });
            sleepStep = sleep(0.05);
          },
        );

        When("the step runs", async () => {
          startedAt = Date.now();
          const maybe = agentStep(ctx.state, ctx.executor);
          if (maybe && typeof (maybe as Promise<unknown>).then === "function") {
            await maybe;
          }
          returnedAt = Date.now();
          await sleepStep(ctx.state, ctx.executor);
        });

        Then("control returns before the agent finishes speaking", () => {
          // agent() takes ~200ms; with wait=false we should return well below that.
          expect(returnedAt - startedAt).toBeLessThan(100);

          // The `voiceAgent` alias resolves to the same non-blocking behavior:
          // calling it returns synchronously (undefined, not a Promise) for
          // `{ wait: false }`, exactly like `agent({ wait: false })`.
          const aliasCtx = makeExecutor(new TestVoiceAdapter(), {
            agentDelayMs: 200,
          });
          const aliasResult = voiceAgent({ wait: false })(
            aliasCtx.state,
            aliasCtx.executor,
          );
          expect(aliasResult).toBeUndefined();
        });

        And("the agent's audio continues streaming during the sleep", () => {
          // Trace records the agent call even though we didn't await it.
          expect(ctx.trace).toContain("agent:(default)");
        });
      },
    );

    // ------------------------------------------------------ audio (WAV file)
    Scenario(
      "scenario.audio() injects a WAV file",
      ({ Given, When, Then, And }) => {
        const adapter = new TestVoiceAdapter();
        const ctx = makeExecutor(adapter);
        let step: ReturnType<typeof audio>;
        let wavPath: string;
        let dir: string;

        Given(
          'scenario.audio("fixtures/angry_customer_rant.wav") in a script',
          () => {
            dir = mkdtempSync(join(tmpdir(), "ts-voice-audio-"));
            wavPath = join(dir, "sample.wav");
            writeFileSync(wavPath, createTestWav(0.05));
            step = audio(wavPath);
          },
        );

        When("the step runs", async () => {
          await step(ctx.state, ctx.executor);
        });

        Then(
          "the file is loaded, converted to the transport format, and sent as user input",
          () => {
            expect(adapter.sentAudio).toHaveLength(1);
            expect(adapter.sentAudio[0]).toBeInstanceOf(AudioChunk);
            expect(adapter.sentAudio[0].data.length).toBeGreaterThan(0);
          },
        );

        And("the user simulator is bypassed for that turn", () => {
          // The audio step never calls executor.user, so the trace has no
          // user-message entry.
          expect(ctx.trace).not.toContain("user:(default)");
        });
      },
    );

    // ----------------------------------------------------- audio (raw bytes)
    Scenario(
      "scenario.audio() accepts raw bytes",
      ({ Given, When, Then }) => {
        const adapter = new TestVoiceAdapter();
        const ctx = makeExecutor(adapter);
        let step: ReturnType<typeof audio>;

        Given('scenario.audio(b"...raw audio bytes...") in a script', () => {
          const wavBytes = createTestWav(0.05);
          step = audio(wavBytes);
        });

        When("the step runs", async () => {
          await step(ctx.state, ctx.executor);
        });

        Then(
          "the bytes are converted to the transport format and sent as user input",
          () => {
            expect(adapter.sentAudio).toHaveLength(1);
            expect(adapter.sentAudio[0].data.length).toBeGreaterThan(0);
          },
        );
      },
    );

    // ----------------------------------------------- audio formats (4 codecs)
    Scenario(
      "scenario.audio() supports WAV, MP3, OGG, FLAC",
      ({ Given, When, Then }) => {
        const adapter = new TestVoiceAdapter();
        const ctx = makeExecutor(adapter);
        const expectedFormats = ["wav", "mp3", "ogg", "flac"] as const;
        const paths: string[] = [];

        Given(
          "scenario.audio() called with each of .wav, .mp3, .ogg, .flac fixtures",
          () => {
            const dir = mkdtempSync(join(tmpdir(), "ts-voice-fmts-"));
            const wavBytes = createTestWav(0.05);
            const wavPath = join(dir, "src.wav");
            writeFileSync(wavPath, wavBytes);
            paths.push(wavPath);
            for (const fmt of expectedFormats.slice(1)) {
              const outPath = join(dir, `src.${fmt}`);
              transcodeWith(resolveFfmpegPath(), wavPath, outPath, fmt);
              paths.push(outPath);
            }
          },
        );

        When("each step runs", async () => {
          for (const p of paths) {
            await audio(p)(ctx.state, ctx.executor);
          }
        });

        Then(
          "the file is auto-converted to the transport's format via ffmpeg (bundled)",
          () => {
            expect(adapter.sentAudio).toHaveLength(expectedFormats.length);
            for (const chunk of adapter.sentAudio) {
              expect(chunk.data.length).toBeGreaterThan(0);
            }
          },
        );
      },
    );

    // ------------------------------------------------- dtmf (telephony stub)
    Scenario(
      'scenario.dtmf(tones) emits DTMF tones',
      ({ Given, When, Then }) => {
        const adapter = new TestVoiceAdapter({ dtmf: true });
        const ctx = makeExecutor(adapter);
        let step: ReturnType<typeof dtmf>;

        Given(
          'a TwilioAgentAdapter and scenario.dtmf("1") in a script',
          () => {
            step = dtmf("1");
          },
        );

        When("the step runs", async () => {
          await step(ctx.state, ctx.executor);
        });

        Then(
          'the DTMF tone "1" is transmitted through the telephony channel',
          () => {
            expect(adapter.sentDtmf).toEqual(["1"]);
          },
        );
      },
    );

    // -------------------------------------------- interrupt(after=T, content)
    Scenario(
      'scenario.interrupt(after=T, content="...") composes wait=False + sleep + user',
      ({ Given, When, Then }) => {
        const adapter = new TestVoiceAdapter({ interruption: true });
        // Pretend speech has already started so the bounded wait resolves fast.
        adapter.agentSpeakingEvent = {
          isSet: () => true,
          wait: () => Promise.resolve(),
        };
        const ctx = makeExecutor(adapter);
        let step: ReturnType<typeof interrupt>;

        Given(
          'scenario.interrupt(after=2.0, content="Wait, that\'s wrong!")',
          () => {
            step = interrupt({
              content: "Wait, that's wrong!",
              waitForSpeechTimeout: 0.1,
            });
          },
        );

        When("the step runs", async () => {
          await step(ctx.state, ctx.executor);
        });

        Then(
          'it is equivalent to agent(wait=False) then sleep(2.0) then user("Wait, that\'s wrong!")',
          () => {
            // Trace order: agent fires first (in background), user fires after wait.
            const agentIdx = ctx.trace.findIndex((t) => t.startsWith("agent:"));
            const userIdx = ctx.trace.findIndex((t) =>
              t.startsWith("user:Wait, that"),
            );
            expect(agentIdx).toBeGreaterThanOrEqual(0);
            expect(userIdx).toBeGreaterThanOrEqual(0);
            expect(agentIdx).toBeLessThan(userIdx);
          },
        );
      },
    );

    // --------------------------------------------- interrupt(after_words, ok)
    Scenario(
      "scenario.interrupt(after_words=N) uses streaming transcript when available",
      ({ Given, When, Then }) => {
        const adapter = new TestVoiceAdapter({ streamingTranscripts: true });
        const ctx = makeExecutor(adapter);
        let step: ReturnType<typeof interrupt>;

        Given(
          "the adapter exposes a streaming transcript and after_words=5 is used",
          () => {
            step = interrupt({ afterWords: 5, content: "stop" });
          },
        );

        When("the agent emits the 5th word", async () => {
          const resultPromise = Promise.resolve(step(ctx.state, ctx.executor));
          // Drip-feed five words into the streaming transcript so the step
          // can advance past `waitForStreamingWords`.
          adapter.streamingTranscript = "one two three four five";
          await resultPromise;
        });

        Then("the interrupt content is immediately sent", () => {
          expect(ctx.trace).toContain("user:stop");
        });
      },
    );

    // ----------------------------------------- interrupt(after_words, raises)
    Scenario(
      "scenario.interrupt(after_words=N) raises a clear error when adapter lacks streaming transcripts",
      ({ Given, When, Then, And }) => {
        const adapter = new TestVoiceAdapter({ streamingTranscripts: false });
        const ctx = makeExecutor(adapter);
        let step: ReturnType<typeof interrupt>;
        let caught: unknown;

        Given("the adapter does NOT expose a streaming transcript", () => {
          expect(adapter.capabilities.streamingTranscripts).toBe(false);
        });

        When("scenario.interrupt(after_words=5) is executed", async () => {
          step = interrupt({ afterWords: 5 });
          try {
            await step(ctx.state, ctx.executor);
          } catch (err) {
            caught = err;
          }
        });

        Then(
          "a clear UnsupportedCapabilityError is raised naming the adapter and the missing capability",
          () => {
            expect(caught).toBeInstanceOf(UnsupportedCapabilityError);
            const err = caught as UnsupportedCapabilityError;
            expect(err.capability).toBe("streaming_transcripts");
            expect(err.adapterName).toContain("TestVoiceAdapter");
          },
        );

        And("the error message points to the capability matrix in the docs", () => {
          // Same hosted-docs URL the Python reference implementation emits
          // (python/scenario/voice/capabilities.py) — not a repo-relative path.
          expect((caught as Error).message).toContain(
            "scenario-docs.langwatch.ai/voice/capability-matrix",
          );
        });
      },
    );

    // -------------------------------------------- proceed(interruptions=cfg)
    Scenario(
      "proceed(interruptions=InterruptionConfig(...)) injects random interruptions",
      ({ Given, When, Then, And }) => {
        const adapter = new TestVoiceAdapter();
        const ctx = makeExecutor(adapter);
        const cfg = new InterruptionConfig({
          probability: 0.3,
          delayRange: [0.5, 3.0],
          strategy: "contextual",
        });
        let step: ReturnType<typeof voiceProceed>;

        Given(
          "proceed(turns=5, interruptions=InterruptionConfig(probability=0.3, delay_range=(0.5,3.0), strategy=\"contextual\"))",
          () => {
            step = voiceProceed({ turns: 5, interruptions: cfg });
          },
        );

        When("proceed runs", async () => {
          await step(ctx.state, ctx.executor);
        });

        Then(
          "~30% of agent turns are interrupted with contextual LLM-generated phrases",
          () => {
            // voiceProceed sets the config during proceed and restores it
            // afterwards (save-set-restore pattern, P2 config-leak fix).
            // The executor reads it inside the proceed loop (where it IS cfg);
            // after proceed the field is restored to its prior value.
            expect(
              (ctx.executor as { voiceInterruptions?: InterruptionConfig })
                .voiceInterruptions,
            ).toBeUndefined();
            // Sanity: probability check still respects the configured ratio
            // over a large sample (binomial spread tolerated).
            let hits = 0;
            const seedRng = makeSeededRng(42);
            for (let i = 0; i < 5000; i++) {
              if (cfg.shouldInterrupt(seedRng)) hits += 1;
            }
            const ratio = hits / 5000;
            expect(ratio).toBeGreaterThan(0.27);
            expect(ratio).toBeLessThan(0.33);
          },
        );

        And("delay before each interrupt is sampled uniformly in [0.5, 3.0]", () => {
          const rng = makeSeededRng(7);
          for (let i = 0; i < 1000; i++) {
            const delay = cfg.sampleDelay(rng);
            expect(delay).toBeGreaterThanOrEqual(0.5);
            expect(delay).toBeLessThanOrEqual(3.0);
          }
        });
      },
    );
  },
  { includeTags: [["ts-script-step"]] },
);

// ---------------------------------------------------------------- helpers

function createTestWav(durationSeconds: number): Uint8Array {
  const sampleRate = 24000;
  const channels = 1;
  const sampleWidth = 2;
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataBytes = numSamples * sampleWidth;
  const headerSize = 44;
  const out = new Uint8Array(headerSize + dataBytes);
  const view = new DataView(out.buffer);
  writeAscii(out, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(out, 8, "WAVE");
  writeAscii(out, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * sampleWidth, true);
  view.setUint16(32, channels * sampleWidth, true);
  view.setUint16(34, sampleWidth * 8, true);
  writeAscii(out, 36, "data");
  view.setUint32(40, dataBytes, true);
  // Non-silent PCM so transcoders don't emit empty audio.
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(headerSize + i * 2, (i * 80) % 30000 - 15000, true);
  }
  return out;
}

function writeAscii(out: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    out[offset + i] = value.charCodeAt(i);
  }
}

function transcodeWith(
  bin: string,
  input: string,
  output: string,
  fmt: string,
): void {
  const res = spawnSync(bin, [
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-f",
    fmt,
    output,
  ]);
  if (res.status !== 0) {
    throw new Error(
      `ffmpeg failed to transcode to ${fmt}: ${res.stderr?.toString("utf8") ?? ""}`,
    );
  }
}

/** Tiny seeded PRNG (mulberry32) for deterministic probability tests. */
function makeSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- P2 config-leak fix

/**
 * Regression test for P2 (review #4382164555):
 * `voiceProceed({ interruptions })` must NOT leak its config to subsequent
 * voiceProceed calls that do not pass `interruptions`.
 *
 * Before the fix, the config was written to `executor.voiceInterruptions` and
 * never restored.  A subsequent plain `proceed()` or `voiceProceed({ turns })`
 * would find the stale config and apply interruptions unexpectedly.
 */
describe("voiceProceed — save/restore voiceInterruptions (P2 config-leak fix)", () => {
  it("does not leak voiceInterruptions to a subsequent voiceProceed without interruptions", async () => {
    const cfg = new InterruptionConfig({
      probability: 0.5,
      strategy: "random_phrase",
    });

    // Executor stub with a mutable voiceInterruptions field so we can observe
    // the save-set-restore lifecycle across two voiceProceed calls.
    const capturedDuring: Array<InterruptionConfig | undefined> = [];
    const vex: {
      voiceInterruptions?: InterruptionConfig;
      proceed: (turns?: number) => Promise<null>;
    } = {
      voiceInterruptions: undefined,
      async proceed(_turns?: number) {
        // Capture what voiceInterruptions looks like DURING proceed.
        capturedDuring.push(vex.voiceInterruptions);
        return null;
      },
    };

    const state = {} as never;

    // First voiceProceed: passes interruptions.
    const step1 = voiceProceed({ turns: 1, interruptions: cfg });
    await step1(state, vex as never);

    // voiceInterruptions must be RESTORED after the step (not leaked).
    expect(
      vex.voiceInterruptions,
      "voiceInterruptions was not restored after first voiceProceed — config leaked",
    ).toBeUndefined();
    // During proceed the config must have been set.
    expect(capturedDuring[0]).toBe(cfg);

    // Second voiceProceed: no interruptions.
    const step2 = voiceProceed({ turns: 1 });
    await step2(state, vex as never);

    // Must NOT see the first call's config.
    expect(
      capturedDuring[1],
      "second voiceProceed saw the first call's interruption config — leak not fixed",
    ).toBeUndefined();
  });
});
