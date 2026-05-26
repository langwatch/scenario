/**
 * STT subtree unit tests (Gap #1 — the `stt/` split).
 *
 * Plain vitest unit tests, no scenario binding. The old `@ts-stt`-tagged
 * cucumber binding matched nothing (the STT scenarios in
 * `specs/voice-agents.feature` are tagged `@unit`; EDR §7.4) and exercised
 * removed APIs (`setSttProvider`/`getSttProvider` global, the invented
 * `scenario.configure(stt=...)`, and a non-existent "judge requests a
 * transcript" step; EDR §7.3/§7.5). Provider state is now per-run on
 * `ScenarioConfig.voice` (ADR-002); these tests cover the provider behavior
 * and the `"provider/model"` router directly.
 */
import { describe, it, expect, vi } from "vitest";

import { AudioChunk, silentChunk } from "../audio-chunk";
import {
  OPENAI_TRANSCRIBE_LIMIT_SECONDS,
  OpenAISTTProvider,
  ElevenLabsSTTProvider,
  resolveSttProvider,
  registerSttProvider,
  listSttProviders,
  type STTProvider,
} from "../stt";
import { OPENAI_STT_MODEL } from "../voice-models";

type OpenAILike = {
  audio: {
    transcriptions: {
      create: ReturnType<typeof vi.fn>;
    };
  };
};

function makeMockOpenAI(text = "transcribed"): OpenAILike {
  return {
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue({ text }),
      },
    },
  };
}

describe("OpenAISTTProvider — default model", () => {
  it("defaults to gpt-4o-transcribe", () => {
    expect(new OpenAISTTProvider().model).toBe(OPENAI_STT_MODEL);
    expect(OPENAI_STT_MODEL).toBe("gpt-4o-transcribe");
  });

  it("calls openai.audio.transcriptions with the configured model", async () => {
    const mock = makeMockOpenAI("hi");
    const provider = new OpenAISTTProvider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiClient: mock as any,
    });
    await provider.transcribe(silentChunk(0.5));
    const args = mock.audio.transcriptions.create.mock.calls[0][0];
    expect(args.model).toBe("gpt-4o-transcribe");
  });
});

describe("STTProvider interface is minimal and provider-agnostic", () => {
  it("a plain object literal satisfies STTProvider (single async method)", async () => {
    const minimal: STTProvider = {
      transcribe: async (audio: AudioChunk): Promise<string> => {
        expect(audio).toBeInstanceOf(AudioChunk);
        return "ok";
      },
    };
    expect(await minimal.transcribe(silentChunk(0.01))).toBe("ok");
  });

  it("no OpenAI-specific types leak into the interface", () => {
    const p: STTProvider = {
      async transcribe(audio) {
        return audio.transcript ?? "";
      },
    };
    expect(p).toBeDefined();
  });
});

describe("OpenAISTTProvider — chunking over the 25-minute limit", () => {
  it("documents the 25-minute API limit", () => {
    expect(OPENAI_TRANSCRIBE_LIMIT_SECONDS).toBe(25 * 60);
  });

  it("splits audio over the limit into sub-requests and concatenates", async () => {
    const mock = makeMockOpenAI();
    let call = 0;
    mock.audio.transcriptions.create.mockImplementation(async () => ({
      text: `seg${++call}`,
    }));
    const provider = new OpenAISTTProvider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiClient: mock as any,
      transcribeLimitSeconds: 1,
    });
    // 2.5s at 1s limit → 3 sub-calls (1s, 1s, 0.5s).
    const result = await provider.transcribe(silentChunk(2.5));
    expect(mock.audio.transcriptions.create).toHaveBeenCalledTimes(3);
    expect(result).toBe("seg1 seg2 seg3");
  });

  it("uses a single request when under the limit", async () => {
    const mock = makeMockOpenAI("short");
    const provider = new OpenAISTTProvider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiClient: mock as any,
      transcribeLimitSeconds: 2,
    });
    const text = await provider.transcribe(silentChunk(1));
    expect(mock.audio.transcriptions.create).toHaveBeenCalledTimes(1);
    expect(text).toBe("short");
  });

  it("drops empty sub-chunk transcripts from the joined result", async () => {
    const mock = makeMockOpenAI();
    let call = 0;
    mock.audio.transcriptions.create.mockImplementation(async () => {
      call += 1;
      return { text: call === 2 ? "" : `seg${call}` };
    });
    const provider = new OpenAISTTProvider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiClient: mock as any,
      transcribeLimitSeconds: 1,
    });
    expect(await provider.transcribe(silentChunk(2.5))).toBe("seg1 seg3");
  });
});

describe("resolveSttProvider — the provider/model router", () => {
  it("resolves the built-in OpenAI provider", () => {
    expect(resolveSttProvider("openai/gpt-4o-transcribe")).toBeInstanceOf(
      OpenAISTTProvider,
    );
  });

  it("honors the model segment of the spec", () => {
    const p = resolveSttProvider("openai/whisper-1") as OpenAISTTProvider;
    expect(p.model).toBe("whisper-1");
  });

  it("resolves the built-in ElevenLabs provider", () => {
    expect(resolveSttProvider("elevenlabs/scribe_v1")).toBeInstanceOf(
      ElevenLabsSTTProvider,
    );
  });

  it("lists the registered providers", () => {
    expect(listSttProviders()).toEqual(
      expect.arrayContaining(["openai", "elevenlabs"]),
    );
  });

  it("throws a clear error for an unknown provider segment", () => {
    expect(() => resolveSttProvider("deepgram/nova-2")).toThrow(
      /Unknown STT provider "deepgram"/,
    );
  });

  it("supports registering a custom provider factory", () => {
    const custom: STTProvider = { transcribe: async () => "custom" };
    registerSttProvider("myvendor", () => custom);
    expect(resolveSttProvider("myvendor/anything")).toBe(custom);
  });
});
