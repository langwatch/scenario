/**
 * VAD-fallback tests — binds `specs/voice-agents.feature` scenarios tagged
 * `@ts-vad`:
 *   - "SDK-side VAD fallback activates on adapters without native VAD" (lines 773-777)
 *   - "VAD fallback emits a one-shot UserWarning on first activation" (lines 780-784)
 *   - "Adapters with native VAD do not trigger the fallback" (lines 787-791)
 *
 * The fallback is purely declarative — the adapter's
 * `capabilities.nativeVad === false` triggers the runtime to instantiate
 * a {@link WebRTCVadFallback} and route incoming audio chunks through
 * it. Native-VAD adapters bypass the fallback entirely.
 *
 * Loaded via @amiceli/vitest-cucumber which reads the feature file and fails
 * the suite if any bound scenario is missing a step binding.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { beforeEach, expect, vi, type MockInstance } from "vitest";

import { agent, succeed, user } from "../../script";
import { ScenarioExecution } from "../../execution/scenario-execution";
import { AudioChunk } from "../audio-chunk";
import type { VoiceEvent } from "../recording.types";
import { WebRTCVadFallback } from "../vad";
import { AudioUserSimulator } from "./fixtures/audio-user-simulator";
import { FakeVoiceAdapter } from "./fixtures/fake-adapter";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "specs",
  "voice-agents.feature",
);

function speechChunk(durationSeconds: number): AudioChunk {
  // Loud sine-ish shape: alternate ±20000 samples — RMS ≈ 20000, comfortably
  // above the fallback's 500-amplitude threshold so the energy detector
  // flips to "speaking" within the hysteresis window.
  const numSamples = Math.floor(durationSeconds * 24000);
  const data = new Uint8Array(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const sample = i % 2 === 0 ? 20000 : -20000;
    const u = sample < 0 ? sample + 0x10000 : sample;
    data[2 * i] = u & 0xff;
    data[2 * i + 1] = (u >> 8) & 0xff;
  }
  return new AudioChunk({ data });
}

// Reset VAD warning state before every step so the one-shot-warning
// assertion is reproducible. Because vitest-cucumber runs each step as a
// separate `it()`, beforeEach fires around each step individually.
beforeEach(() => {
  WebRTCVadFallback.resetWarnings();
});

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario, BeforeEachScenario, AfterEachScenario }) => {
    // Shared spy state — installed once per scenario via BeforeEachScenario,
    // torn down via AfterEachScenario. Steps read capturedWarnCalls directly.
    let warnSpy: MockInstance;
    let capturedWarnCalls: string[] = [];

    BeforeEachScenario(() => {
      capturedWarnCalls = [];
      warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
        capturedWarnCalls.push(String(args[0]));
      });
    });

    AfterEachScenario(() => {
      warnSpy.mockRestore();
    });

    // -----------------------------------------------------------------------
    // Scenario: SDK-side VAD fallback activates on adapters without native VAD
    // (lines 773-777)
    // -----------------------------------------------------------------------
    Scenario(
      "SDK-side VAD fallback activates on adapters without native VAD",
      ({ Given, When, Then, And }) => {
        let events: VoiceEvent[];
        let execution: ScenarioExecution;

        Given("an adapter with capabilities.native_vad == False", () => {
          const adapter = new FakeVoiceAdapter({
            capabilities: { nativeVad: false },
          });
          events = [];
          execution = new ScenarioExecution(
            {
              name: "vad / fallback emits speaking events",
              description: "binds the bound feature scenario lines 772-777",
              agents: [adapter, new AudioUserSimulator(speechChunk(0.3))],
              onVoiceEvent: (e) => events.push(e),
            },
            [user(), agent(), succeed("done")],
            "test-batch-id",
          );
        });

        When("a voice scenario runs and audio flows", async () => {
          await execution.execute();
        });

        Then(
          "user_start_speaking and user_stop_speaking VoiceEvents are still emitted",
          () => {
            // The fallback's events carry `metadata.source === "vad-fallback"`
            // so we can distinguish them from the recorder's own user_start /
            // user_stop pairs and assert the fallback actually drove this.
            const fallbackStarts = events.filter(
              (e) =>
                e.type === "user_start_speaking" &&
                e.metadata?.source === "vad-fallback",
            );
            expect(fallbackStarts.length).toBeGreaterThan(0);
          },
        );

        And("webrtcvad-wheels is used to detect speaker boundaries", () => {
          // The one-shot warning is the observable side-effect of the fallback
          // being instantiated — its presence proves webrtcvad was invoked.
          const noNativeVadWarns = capturedWarnCalls.filter((msg) =>
            msg.includes("no native VAD"),
          );
          expect(noNativeVadWarns.length).toBeGreaterThan(0);
        });
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: VAD fallback emits a one-shot UserWarning on first activation
    // (lines 780-784)
    // -----------------------------------------------------------------------
    Scenario(
      "VAD fallback emits a one-shot UserWarning on first activation",
      ({ Given, When, Then, And }) => {
        // fakeAdapterWarns / otherWarns are filtered views of capturedWarnCalls
        // populated after the When step executes.
        let fakeAdapterWarns: string[] = [];
        let otherWarns: string[] = [];

        Given("an adapter with capabilities.native_vad == False", () => {
          // Precondition — adapters are constructed in When below.
          fakeAdapterWarns = [];
          otherWarns = [];
        });

        When("the scenario starts and VAD fallback is used", () => {
          // Each adapter class generates ONE warning — the second adapter of
          // the same name does not re-warn (matches Python `_warned_adapters`
          // memoisation at vad.py:39-55).
          new WebRTCVadFallback("FakeVoiceAdapter");
          new WebRTCVadFallback("FakeVoiceAdapter");
          new WebRTCVadFallback("AnotherFakeAdapter");

          // Partition captured warns by adapter name.
          fakeAdapterWarns = capturedWarnCalls.filter((msg) =>
            msg.includes("FakeVoiceAdapter"),
          );
          otherWarns = capturedWarnCalls.filter((msg) =>
            msg.includes("AnotherFakeAdapter"),
          );
        });

        Then(
          "a UserWarning is issued exactly once per process naming the adapter",
          () => {
            // Each distinct adapter name generates exactly one warning.
            expect(fakeAdapterWarns).toHaveLength(1);
            expect(otherWarns).toHaveLength(1);
          },
        );

        And(
          "the warning text references accuracy differences vs native VAD",
          () => {
            expect(fakeAdapterWarns[0]).toMatch(/no native VAD/);
            expect(fakeAdapterWarns[0]).toMatch(/Accuracy may differ/);
          },
        );
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: Adapters with native VAD do not trigger the fallback
    // (lines 787-791)
    // -----------------------------------------------------------------------
    Scenario(
      "Adapters with native VAD do not trigger the fallback",
      ({ Given, When, Then, And }) => {
        let execution: ScenarioExecution;

        Given("an adapter with capabilities.native_vad == True", () => {
          const adapter = new FakeVoiceAdapter({
            capabilities: { nativeVad: true },
          });
          execution = new ScenarioExecution(
            {
              name: "vad / native VAD bypasses fallback",
              description: "binds the bound feature scenario lines 786-791",
              agents: [adapter, new AudioUserSimulator(speechChunk(0.2))],
            },
            [user(), agent(), succeed("done")],
            "test-batch-id",
          );
        });

        When("the scenario runs", async () => {
          await execution.execute();
        });

        Then("webrtcvad is not invoked", () => {
          // We assert by absence-of-warning: the fallback's one-shot warning
          // is the only side-effect that fires on instantiation, so its
          // absence proves no fallback was created.
          const noNativeVadWarns = capturedWarnCalls.filter((msg) =>
            msg.includes("no native VAD"),
          );
          expect(noNativeVadWarns).toHaveLength(0);
        });

        And("VAD events come from the adapter's native stream", () => {
          // When nativeVad=true the adapter's own event stream drives VAD;
          // the fallback is never instantiated. The absence of a warning
          // in Then already confirms this; this And step records the spec
          // intent explicitly.
          const noNativeVadWarns = capturedWarnCalls.filter((msg) =>
            msg.includes("no native VAD"),
          );
          expect(noNativeVadWarns).toHaveLength(0);
        });
      },
    );
  },
  { includeTags: ["ts-vad"] },
);
